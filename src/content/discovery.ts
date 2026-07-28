import { createActivityData, tagsModel } from './boat';
import { cosineSimilarity, embedTexts } from './ferry';
import {
	getDeniedStagedActivityIds,
	postStagedActivity,
	retrieveActivityIds
} from '../util/mantle2';
import { tryCache } from '../util/cache';
import { Activity, Bindings } from '../util/types';

// KV layout:
//   activity_discovery:blocklist -> { [foldKey]: { reason, at } }
//   activity_discovery:pending   -> { [foldKey]: { staged_at, staged_id, activity_id } }
//   activity_discovery:cursor    -> { offset, run, rotated_at }
//   activity_discovery:lock      -> '1' with a 10 minute TTL
// single-key JSON indexes rather than one key per entry; KV list is paginated and slow
// (same reasoning as blacklist:index:<kind> in src/admin/blacklist.ts).
const BLOCKLIST_KEY = 'activity_discovery:blocklist';
const PENDING_KEY = 'activity_discovery:pending';
const CURSOR_KEY = 'activity_discovery:cursor';
const LOCK_KEY = 'activity_discovery:lock';
const CATALOG_CACHE_KEY = 'cache:activity_catalog_ids';
const RECENT_TYPES_KEY = 'activity_discovery:recent_types';
const CATALOG_EMBED_KEY = 'activity_discovery:catalog_embeddings';

export const MAX_STAGED_PER_RUN = 5;
export const DISCOVERY_DEADLINE_MS = 120_000;
// must outlive mantle2's 60h cloud fail-open window, or a still-pending submission gets
// re-proposed before it resolves
export const PENDING_TTL_MS = 96 * 60 * 60 * 1000;
export const LOCK_TTL_SECONDS = 600;
export const CATALOG_CACHE_TTL = 3600;
export const CURSOR_STRIDE = MAX_STAGED_PER_RUN * 4;
export const MAX_CONSECUTIVE_AI_FAILURES = 3;
export const MIN_DESCRIPTION_LENGTH = 60;

// how close a candidate may get to something already in the catalog
export const TRIGRAM_SIMILARITY_LIMIT = 0.6;
export const EMBEDDING_SIMILARITY_LIMIT = 0.86;
// survivors are pooled well beyond the stage cap so the type balancer has room to choose
export const SPECIFICITY_BATCH = 24;
// no single activity type may take more than this share of a run
export const MAX_PER_TYPE_PER_RUN = 2;
export const RECENT_TYPE_WINDOW = 40;
export const MAX_SEED_CATEGORIES = 40;

// Wikimedia's User-Agent policy 403s a generic or absent agent
export const DISCOVERY_USER_AGENT =
	'EarthApp-Cloud/1.0 (https://earth-app.com; support@earth-app.com)';

export const DISCOVERY_SEED_CATEGORIES = [
	'Hobbies',
	'Sports',
	'Outdoor recreation',
	'Crafts',
	'Individual sports',
	'Performing arts',
	'Games',
	'Physical exercise'
];

export type DiscoverySource =
	'wikidata_sport' | 'wikidata_hobby' | 'wikipedia_categories' | 'osm_taginfo';

export type Candidate = {
	id: string;
	foldKey: string;
	source: DiscoverySource;
	score: number;
};

export type BlocklistReason =
	'denied' | 'rejected_ai' | 'rejected_genre' | 'rejected_similar' | 'invalid';
export type BlocklistEntry = { reason: BlocklistReason; at: number };
export type PendingEntry = { staged_at: number; staged_id: string; activity_id: string };
export type DiscoveryCursor = { offset: number; run: number; rotated_at: number };

export type DiscoveryFunnel = {
	raw: number;
	bySource: Record<string, number>;
	normalized: number;
	afterCrossSource: number;
	afterBlocklist: number;
	afterPending: number;
	afterCatalog: number;
	afterGenre: number;
	afterSimilarity: number;
	selected: number;
	staged: number;
	failed: number;
	cursorFrom: number;
	cursorTo: number;
	nextUp: string[];
};

export type DiscoveryResult = {
	staged: Activity[];
	// what a real run would enrich and stage next; the point of a dry run
	candidates: string[];
	considered: number;
	funnel: DiscoveryFunnel;
	skipped?: 'locked';
};

// #region Sources

const SOURCE_PRIORITY: Record<DiscoverySource, number> = {
	wikidata_sport: 3,
	wikidata_hobby: 3,
	osm_taginfo: 2,
	wikipedia_categories: 1
};

const SPARQL_QUERIES: Record<'sport' | 'hobby', string> = {
	// Q31629 = "type of sport"
	sport: `SELECT ?itemLabel ?links WHERE {
  ?item wdt:P31 wd:Q31629 ; wikibase:sitelinks ?links .
  FILTER(?links >= 10)
  FILTER NOT EXISTS { ?sub wdt:P279 ?item }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} ORDER BY DESC(?links) LIMIT 300`,
	// Q47728 hobby, Q968907 outdoor recreation, Q59284991 leisure activity, Q2207288 craft
	hobby: `SELECT ?itemLabel ?links WHERE {
  VALUES ?c { wd:Q47728 wd:Q968907 wd:Q59284991 wd:Q2207288 }
  { ?item wdt:P31 ?c } UNION { ?item wdt:P279 ?c }
  ?item wikibase:sitelinks ?links .
  FILTER(?links >= 10)
  FILTER NOT EXISTS { ?sub wdt:P279 ?item }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} ORDER BY DESC(?links) LIMIT 300`
};

/**
 * Wikidata SPARQL, the highest-signal source.
 *
 * The non-transitive P31/P279 shape with the materialized `wikibase:sitelinks` count runs
 * in well under a second. Do NOT switch to `wdt:P31/wdt:P279*` with an aggregation - that
 * combination times out at 60s and returns a non-JSON body.
 *
 * `FILTER NOT EXISTS { ?sub wdt:P279 ?item }` keeps only leaves of the subclass tree. An
 * item with subclasses is a genre ("card game", "martial arts"), not something a person
 * actually does.
 */
export async function fetchWikidataCandidates(kind: 'sport' | 'hobby'): Promise<Candidate[]> {
	const source: DiscoverySource = kind === 'sport' ? 'wikidata_sport' : 'wikidata_hobby';
	const url = `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(
		SPARQL_QUERIES[kind]
	)}`;

	try {
		const res = await fetch(url, {
			headers: {
				Accept: 'application/sparql-results+json',
				'User-Agent': DISCOVERY_USER_AGENT
			},
			signal: AbortSignal.timeout(20_000)
		});

		if (!res.ok) {
			// the next hourly cron is the retry; retrying in-run just deepens the rate limit
			console.warn(`Activity discovery: WDQS ${kind} returned ${res.status}`, {
				retryAfter: res.headers.get('Retry-After')
			});
			return [];
		}

		const body = await res.json<{
			results?: {
				bindings?: Array<{ itemLabel?: { value?: string }; links?: { value?: string } }>;
			};
		}>();

		const candidates: Candidate[] = [];
		for (const binding of body?.results?.bindings ?? []) {
			const normalized = normalizeCandidate(binding.itemLabel?.value ?? '');
			if (!normalized) continue;
			candidates.push({
				...normalized,
				source,
				score: Number(binding.links?.value ?? 0) || 1
			});
		}

		return candidates;
	} catch (err) {
		console.warn(`Activity discovery: WDQS ${kind} failed`, {
			error: err instanceof Error ? err.message : String(err)
		});
		return [];
	}
}

/**
 * MediaWiki category walk; both an independent generator and the WDQS fallback.
 *
 * Only `cmtype=page` yields candidates. Subcategory titles are category names by
 * definition, which is exactly how genres like "card game" and "role playing game" used
 * to get staged; they are used to widen the seed list instead (see collectCandidates).
 */
export async function fetchWikipediaCategoryCandidates(
	category: string,
	type: 'subcat' | 'page' = 'page'
): Promise<Candidate[]> {
	const url =
		`https://en.wikipedia.org/w/api.php?action=query&list=categorymembers` +
		`&cmtitle=${encodeURIComponent(`Category:${category}`)}` +
		`&cmtype=${type}&cmlimit=500&format=json&formatversion=2`;

	try {
		const res = await fetch(url, {
			headers: { 'User-Agent': DISCOVERY_USER_AGENT },
			signal: AbortSignal.timeout(15_000)
		});
		if (!res.ok) return [];

		const body = await res.json<{ query?: { categorymembers?: Array<{ title?: string }> } }>();

		const candidates: Candidate[] = [];
		for (const member of body?.query?.categorymembers ?? []) {
			const normalized = normalizeCandidate(member.title ?? '');
			if (!normalized) continue;
			candidates.push({ ...normalized, source: 'wikipedia_categories', score: 1 });
		}

		return candidates;
	} catch (err) {
		console.warn(`Activity discovery: category walk failed for ${category}`, {
			error: err instanceof Error ? err.message : String(err)
		});
		return [];
	}
}

/**
 * Raw subcategory titles, used only to widen the page walk.
 */
export async function fetchWikipediaSubcategories(category: string): Promise<string[]> {
	const url =
		`https://en.wikipedia.org/w/api.php?action=query&list=categorymembers` +
		`&cmtitle=${encodeURIComponent(`Category:${category}`)}` +
		`&cmtype=subcat&cmlimit=100&format=json&formatversion=2`;

	try {
		const res = await fetch(url, {
			headers: { 'User-Agent': DISCOVERY_USER_AGENT },
			signal: AbortSignal.timeout(15_000)
		});
		if (!res.ok) return [];

		const body = await res.json<{ query?: { categorymembers?: Array<{ title?: string }> } }>();

		return (body?.query?.categorymembers ?? [])
			.map((member) => (member.title ?? '').replace(/^Category:/, '').trim())
			.filter((title) => title.length > 0 && !/[0-9]/.test(title));
	} catch {
		return [];
	}
}

/**
 * OSM taginfo; real-world sport vocabulary already in snake_case.
 */
export async function fetchTaginfoCandidates(key: 'sport' | 'leisure'): Promise<Candidate[]> {
	const url =
		`https://taginfo.openstreetmap.org/api/4/key/values?key=${key}` +
		`&page=1&rp=200&sortname=count_all&sortorder=desc`;

	try {
		const res = await fetch(url, {
			headers: { 'User-Agent': DISCOVERY_USER_AGENT },
			signal: AbortSignal.timeout(15_000)
		});
		if (!res.ok) return [];

		const body = await res.json<{
			data?: Array<{ value?: string; count?: number; in_wiki?: boolean }>;
		}>();

		const candidates: Candidate[] = [];
		for (const row of body?.data ?? []) {
			if (!row.in_wiki || (row.count ?? 0) < 500) continue;
			const normalized = normalizeCandidate(row.value ?? '');
			if (!normalized) continue;
			candidates.push({
				...normalized,
				source: 'osm_taginfo',
				score: (row.count ?? 0) / 1000
			});
		}

		return candidates;
	} catch (err) {
		console.warn(`Activity discovery: taginfo ${key} failed`, {
			error: err instanceof Error ? err.message : String(err)
		});
		return [];
	}
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Every source, plus the in-memory cross-source dedup (L1).
 */
export async function collectCandidates(): Promise<{
	candidates: Candidate[];
	raw: number;
	bySource: Record<string, number>;
}> {
	const all: Candidate[] = [];
	const bySource: Record<string, number> = {};

	const record = (found: Candidate[]) => {
		for (const candidate of found) {
			bySource[candidate.source] = (bySource[candidate.source] ?? 0) + 1;
		}
		all.push(...found);
	};

	record(await fetchWikidataCandidates('sport'));
	record(await fetchWikidataCandidates('hobby'));

	// subcategory titles are category names, so they widen the walk one level rather than
	// becoming candidates themselves
	const seeds = new Set(DISCOVERY_SEED_CATEGORIES);
	for (const category of DISCOVERY_SEED_CATEGORIES) {
		for (const sub of await fetchWikipediaSubcategories(category)) {
			if (seeds.size < MAX_SEED_CATEGORIES) seeds.add(sub);
		}
		// polite spacing; trivially inside anonymous limits either way
		await sleep(150);
	}

	for (const category of seeds) {
		record(await fetchWikipediaCategoryCandidates(category, 'page'));
		await sleep(150);
	}

	record(await fetchTaginfoCandidates('sport'));
	record(await fetchTaginfoCandidates('leisure'));

	const best = new Map<string, Candidate>();
	for (const candidate of all) {
		const existing = best.get(candidate.foldKey);
		if (
			!existing ||
			candidate.score > existing.score ||
			(candidate.score === existing.score &&
				SOURCE_PRIORITY[candidate.source] > SOURCE_PRIORITY[existing.source])
		) {
			best.set(candidate.foldKey, candidate);
		}
	}

	return { candidates: [...best.values()], raw: all.length, bySource };
}

// #endregion

// #region Normalization

const STOPWORDS = new Set([
	'hobby',
	'hobbies',
	'hobbyist',
	'hobbyists',
	'sport',
	'sports',
	'game',
	'games',
	'recreation',
	'leisure',
	'activity',
	'activities',
	'amateurism',
	'fandom',
	'avocation',
	'pastime',
	'pastimes',
	'culture',
	'art',
	'arts'
]);

const LEADING_ARTICLES = new Set(['the', 'a', 'an', 'of', 'in', 'on', 'at', 'for', 'with', 'and']);

function singularize(word: string): string {
	if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`;
	if (word.endsWith('sses') || word.endsWith('shes') || word.endsWith('ches')) {
		return word.slice(0, -2);
	}
	if (word.endsWith('s') && !word.endsWith('ss') && word.length > 3) return word.slice(0, -1);
	return word;
}

/**
 * Fold a raw source label into an activity id, or reject it.
 *
 * The 3-50 length bound is not arbitrary; it is exactly what `GET /activity/:id` already
 * enforces, so anything staged is also retrievable through that route.
 */
export function normalizeCandidate(raw: string): { id: string; foldKey: string } | null {
	if (!raw) return null;

	let text = raw.normalize('NFKD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

	text = text.replace(/^category:\s*/, '');
	text = text.replace(/\s*\([^)]*\)$/, '');
	text = text.replace(/^(list|outline|glossary|index|history|types|timeline) of\s+/, '');
	text = text.replace(/[_-]+/g, ' ').trim();

	if (!text || /[0-9:/#|,'"”“’]/.test(text)) return null;

	const words = text.split(/\s+/).filter(Boolean);
	if (words.length === 0 || words.length > 3) return null;
	if (LEADING_ARTICLES.has(words[0])) return null;
	// reject only when the whole phrase is generic; "board games" and "martial arts" are
	// real activities even though they contain a stopword
	if (words.every((word) => STOPWORDS.has(word))) return null;
	if (!/^[a-z]+(?: [a-z]+){0,2}$/.test(words.join(' '))) return null;

	const id = words.join('_');
	if (id.length < 3 || id.length > 50) return null;

	const folded = [...words];
	folded[folded.length - 1] = singularize(folded[folded.length - 1]);

	return { id, foldKey: folded.join('_') };
}

// #endregion

// #region Genre rejection

// a candidate whose head noun is one of these is a category, not something a person does:
// "card game", "role playing game", "martial arts", "water sports"
const GENRE_HEADS = new Set([
	'game',
	'games',
	'sport',
	'sports',
	'art',
	'arts',
	'activity',
	'activities',
	'hobby',
	'hobbies',
	'pastime',
	'pastimes',
	'recreation',
	'discipline',
	'disciplines',
	'genre',
	'genres',
	'style',
	'styles',
	'technique',
	'techniques',
	'equipment',
	'gear',
	'club',
	'clubs',
	'league',
	'leagues',
	'team',
	'teams',
	'player',
	'players',
	'competition',
	'competitions',
	'championship',
	'championships',
	'tournament',
	'tournaments',
	'event',
	'events',
	'season',
	'seasons',
	'terminology',
	'culture',
	'history',
	'theory',
	'studies',
	'science',
	'venue',
	'venues',
	'facility',
	'facilities'
]);

/**
 * Whether the candidate reads as a category rather than a practice.
 *
 * Purely lexical and deliberately cheap; the AI gate catches the rest.
 */
export function isGenreCandidate(id: string): boolean {
	const words = id.split('_').filter(Boolean);
	if (words.length === 0) return true;

	const head = words[words.length - 1];
	if (GENRE_HEADS.has(head)) return true;

	// a bare abstract noun ("garden", "music") is a thing, not an activity; the gerund
	// form ("gardening") is what we want
	if (words.length === 1 && BARE_NOUN_REJECTS.has(head)) return true;

	return false;
}

// single-word nouns that name a thing or field rather than a practice
const BARE_NOUN_REJECTS = new Set([
	'garden',
	'music',
	'food',
	'travel',
	'nature',
	'water',
	'fitness',
	'health',
	'craft',
	'design',
	'fashion',
	'media',
	'technology',
	'literature',
	'theatre',
	'theater',
	'cinema',
	'film',
	'radio',
	'television'
]);

const SPECIFICITY_SYSTEM = `You classify whether a term names a SPECIFIC activity a person can practice, or a BROAD category/genre.

SPECIFIC examples: jiujitsu, bouldering, sourdough baking, birdwatching, kitesurfing, calligraphy, gardening
BROAD examples: card game, role playing game, martial arts, water sports, garden, music, board game, team sport

Reply with one line per input, in order, formatted exactly as:
<index>. SPECIFIC
or
<index>. BROAD

No other text.`;

/**
 * Batch-classify candidates as a concrete practice or a broad genre.
 *
 * One small-model call for the whole batch. Fails OPEN (keeps everything) so an AI outage
 * degrades variety rather than halting the pipeline.
 */
export async function filterSpecificCandidates(
	env: Bindings,
	candidates: Candidate[]
): Promise<{ kept: Candidate[]; rejected: Candidate[] }> {
	if (candidates.length === 0) return { kept: [], rejected: [] };

	const listing = candidates
		.map((candidate, index) => `${index + 1}. ${candidate.id.replace(/_/g, ' ')}`)
		.join('\n');

	let response: string;
	try {
		const result = await (env.AI as Ai).run(tagsModel, {
			messages: [
				{ role: 'system', content: SPECIFICITY_SYSTEM },
				{ role: 'user', content: listing }
			],
			max_tokens: 16 * candidates.length + 64,
			temperature: 0
		});
		response = String((result as { response?: string })?.response ?? '');
	} catch (err) {
		console.warn('Activity discovery: specificity gate unavailable, keeping all candidates', {
			error: err instanceof Error ? err.message : String(err)
		});
		return { kept: candidates, rejected: [] };
	}

	const verdicts = new Map<number, boolean>();
	for (const line of response.split('\n')) {
		const match = line.match(/^\s*(\d+)\s*[.):]\s*(SPECIFIC|BROAD)\b/i);
		if (match) verdicts.set(Number(match[1]), match[2].toUpperCase() === 'SPECIFIC');
	}

	// an unparseable or missing verdict keeps the candidate
	const kept: Candidate[] = [];
	const rejected: Candidate[] = [];
	candidates.forEach((candidate, index) => {
		if (verdicts.get(index + 1) === false) rejected.push(candidate);
		else kept.push(candidate);
	});

	return { kept, rejected };
}

// #endregion

// #region Similarity

function trigrams(value: string): Set<string> {
	// separators are dropped so "jiu_jitsu" and "jiujitsu" collapse onto each other; keeping
	// them would let the same practice in twice under a different spelling
	const padded = `  ${value.replace(/[_\s-]/g, '')}  `;
	const grams = new Set<string>();
	for (let i = 0; i < padded.length - 2; i++) grams.add(padded.slice(i, i + 3));

	return grams;
}

function jaccard(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;

	let intersection = 0;
	for (const value of a) if (b.has(value)) intersection++;

	return intersection / (a.size + b.size - intersection);
}

/**
 * Highest trigram overlap between the candidate and anything already in the catalog.
 *
 * Catches spelling and inflection drift ("sea kayak" vs "sea kayaking") for free, before
 * anything reaches the embedding model.
 */
export function lexicalSimilarity(
	id: string,
	catalog: Iterable<string>,
	precomputed?: Set<string>[]
): number {
	const candidate = trigrams(id);
	const entries = precomputed ?? [...catalog].map(trigrams);
	let best = 0;

	for (const entry of entries) {
		const score = jaccard(candidate, entry);
		if (score > best) best = score;
		if (best >= 1) break;
	}

	return best;
}

/** catalog trigram sets, built once per run rather than per candidate */
export function buildTrigramIndex(catalog: Iterable<string>): Set<string>[] {
	return [...catalog].map(trigrams);
}

/**
 * Semantic near-duplicate check against the catalog.
 *
 * Embeddings are cached per text by ferry's embedTexts, so the catalog side is paid for
 * once and reused across runs. Fails OPEN on an AI error.
 */
export async function filterSemanticDuplicates(
	env: Bindings,
	candidates: Candidate[],
	catalog: string[]
): Promise<{ kept: Candidate[]; rejected: Candidate[] }> {
	if (candidates.length === 0 || catalog.length === 0) {
		return { kept: candidates, rejected: [] };
	}

	const readable = (value: string) => value.replace(/_/g, ' ');

	try {
		const [candidateVectors, catalogVectors] = await Promise.all([
			embedTexts(
				env,
				candidates.map((candidate) => readable(candidate.id))
			),
			embedTexts(env, catalog.map(readable))
		]);

		const kept: Candidate[] = [];
		const rejected: Candidate[] = [];

		candidates.forEach((candidate, index) => {
			const vector = candidateVectors[index];
			if (!vector) {
				kept.push(candidate);
				return;
			}

			const tooClose = catalogVectors.some(
				(entry) => entry && cosineSimilarity(vector, entry) >= EMBEDDING_SIMILARITY_LIMIT
			);
			if (tooClose) rejected.push(candidate);
			else kept.push(candidate);
		});

		return { kept, rejected };
	} catch (err) {
		console.warn('Activity discovery: semantic dedup unavailable, keeping all candidates', {
			error: err instanceof Error ? err.message : String(err)
		});
		return { kept: candidates, rejected: [] };
	}
}

// #endregion

// #region Ledgers

async function readJson<T>(env: Bindings, key: string, fallback: T): Promise<T> {
	try {
		const raw = await env.KV.get(key);
		if (!raw) return fallback;
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === 'object' ? (parsed as T) : fallback;
	} catch {
		return fallback;
	}
}

export async function readDiscoveryBlocklist(
	env: Bindings
): Promise<Record<string, BlocklistEntry>> {
	return readJson<Record<string, BlocklistEntry>>(env, BLOCKLIST_KEY, {});
}

export async function addToDiscoveryBlocklist(
	env: Bindings,
	foldKey: string,
	reason: BlocklistReason,
	now: number = Date.now()
): Promise<void> {
	const blocklist = await readDiscoveryBlocklist(env);
	blocklist[foldKey] = { reason, at: now };
	await env.KV.put(BLOCKLIST_KEY, JSON.stringify(blocklist));
}

export async function removeFromDiscoveryBlocklist(
	env: Bindings,
	foldKey: string
): Promise<boolean> {
	const blocklist = await readDiscoveryBlocklist(env);
	if (!(foldKey in blocklist)) return false;

	delete blocklist[foldKey];
	await env.KV.put(BLOCKLIST_KEY, JSON.stringify(blocklist));
	return true;
}

/**
 * Pending submissions, pruned on read at 96h (60h fail-open plus slack).
 */
export async function readPendingLedger(
	env: Bindings,
	now: number = Date.now()
): Promise<Record<string, PendingEntry>> {
	const pending = await readJson<Record<string, PendingEntry>>(env, PENDING_KEY, {});
	const fresh: Record<string, PendingEntry> = {};

	for (const [key, entry] of Object.entries(pending)) {
		if (now - (entry?.staged_at ?? 0) <= PENDING_TTL_MS) fresh[key] = entry;
	}

	return fresh;
}

async function addToPendingLedger(
	env: Bindings,
	foldKey: string,
	entry: PendingEntry
): Promise<void> {
	const pending = await readPendingLedger(env, entry.staged_at);
	pending[foldKey] = entry;
	await env.KV.put(PENDING_KEY, JSON.stringify(pending));
}

export async function readDiscoveryCursor(env: Bindings): Promise<DiscoveryCursor> {
	const cursor = await readJson<Partial<DiscoveryCursor>>(env, CURSOR_KEY, {});

	return {
		offset: Number(cursor.offset) || 0,
		run: Number(cursor.run) || 0,
		rotated_at: Number(cursor.rotated_at) || 0
	};
}

/**
 * Fold every catalog id, name, and alias so a synonym blocks a candidate too.
 */
async function readCatalogKeys(env: Bindings): Promise<string[]> {
	return tryCache<string[]>(
		CATALOG_CACHE_KEY,
		env.CACHE,
		async () => {
			// bare ids at 1000/page; the whole catalog in one or two requests
			const ids = await retrieveActivityIds(env);
			const keys = new Set<string>();

			for (const id of ids) {
				const normalized = normalizeCandidate(id);
				keys.add(normalized ? normalized.foldKey : id.toLowerCase());
			}

			return [...keys];
		},
		CATALOG_CACHE_TTL
	);
}

// #endregion

// #region Selection

export async function selectCandidates(
	env: Bindings,
	opts: { limit?: number; now?: number } = {}
): Promise<{ selected: Candidate[]; survivors: Candidate[]; funnel: DiscoveryFunnel }> {
	const now = opts.now ?? Date.now();
	const limit = Math.max(1, Math.min(MAX_STAGED_PER_RUN, opts.limit ?? MAX_STAGED_PER_RUN));

	const { candidates, raw, bySource } = await collectCandidates();
	const afterCrossSource = candidates.length;

	// nothing writes reason:'denied' on its own, so pull mantle2's denials each run; one
	// subrequest, no mantle2 change, and it self-heals if KV is ever wiped
	const denied = await getDeniedStagedActivityIds(env);
	const blocklist = await readDiscoveryBlocklist(env);
	for (const activityId of denied) {
		const normalized = normalizeCandidate(activityId);
		const key = normalized ? normalized.foldKey : activityId.toLowerCase();
		if (!blocklist[key]) blocklist[key] = { reason: 'denied', at: now };
	}
	if (denied.length > 0) {
		await env.KV.put(BLOCKLIST_KEY, JSON.stringify(blocklist));
	}

	const notBlocked = candidates.filter((candidate) => !blocklist[candidate.foldKey]);
	const pending = await readPendingLedger(env, now);
	const notPending = notBlocked.filter((candidate) => !pending[candidate.foldKey]);

	const catalogKeys = await readCatalogKeys(env);
	const catalogSet = new Set(catalogKeys);
	const afterCatalogList = notPending.filter((candidate) => !catalogSet.has(candidate.foldKey));

	// a genre is never worth an AI call, so the cheap lexical pass runs first
	const genreRejects: Candidate[] = [];
	const notGenre = afterCatalogList.filter((candidate) => {
		if (isGenreCandidate(candidate.id)) {
			genreRejects.push(candidate);
			return false;
		}
		return true;
	});

	// near-duplicates of the catalog, by spelling
	const catalogTrigrams = buildTrigramIndex(catalogKeys);
	const lexicalRejects: Candidate[] = [];
	const notLexicalDupe = notGenre.filter((candidate) => {
		if (
			lexicalSimilarity(candidate.foldKey, catalogKeys, catalogTrigrams) >= TRIGRAM_SIMILARITY_LIMIT
		) {
			lexicalRejects.push(candidate);
			return false;
		}
		return true;
	});

	const ranked = notLexicalDupe.sort(
		(a, b) => b.score - a.score || a.foldKey.localeCompare(b.foldKey)
	);

	// every source is stable DESC-by-popularity, so without rotation a transient failure
	// pins the same head-of-list candidates forever
	const cursor = await readDiscoveryCursor(env);
	const start = ranked.length ? cursor.offset % ranked.length : 0;
	const rotated = ranked.slice(start).concat(ranked.slice(0, start));

	// only the shortlist reaches the paid gates
	const shortlist = rotated.slice(0, SPECIFICITY_BATCH);
	const { kept: specific, rejected: broad } = await filterSpecificCandidates(env, shortlist);
	const { kept: distinct, rejected: semanticDupes } = await filterSemanticDuplicates(
		env,
		specific,
		catalogKeys
	);

	// remember every rejection so the same candidate is never paid for twice
	await recordRejections(
		env,
		[
			...genreRejects.map((candidate) => [candidate, 'rejected_genre'] as const),
			...lexicalRejects.map((candidate) => [candidate, 'rejected_similar'] as const),
			...broad.map((candidate) => [candidate, 'rejected_genre'] as const),
			...semanticDupes.map((candidate) => [candidate, 'rejected_similar'] as const)
		],
		now
	);

	const selected = await balanceByType(env, distinct, limit);
	const survivors = rotated;

	return {
		selected,
		survivors,
		funnel: {
			raw,
			bySource,
			normalized: afterCrossSource,
			afterCrossSource,
			afterBlocklist: notBlocked.length,
			afterPending: notPending.length,
			afterCatalog: afterCatalogList.length,
			afterGenre: notGenre.length,
			afterSimilarity: distinct.length,
			selected: selected.length,
			staged: 0,
			failed: 0,
			cursorFrom: start,
			cursorTo: start,
			nextUp: distinct
				.filter((candidate) => !selected.includes(candidate))
				.slice(0, 20)
				.map((candidate) => candidate.id)
		}
	};
}

async function recordRejections(
	env: Bindings,
	entries: ReadonlyArray<readonly [Candidate, BlocklistReason]>,
	now: number
): Promise<void> {
	if (entries.length === 0) return;

	const blocklist = await readDiscoveryBlocklist(env);
	for (const [candidate, reason] of entries) {
		blocklist[candidate.foldKey] ??= { reason, at: now };
	}
	await env.KV.put(BLOCKLIST_KEY, JSON.stringify(blocklist));
}

/**
 * Spread a run across activity types instead of taking the top N of one flavour.
 *
 * The candidate's source is the only type signal available before enrichment, so this
 * balances on the seed word and on what recent runs already staged.
 */
async function balanceByType(
	env: Bindings,
	candidates: Candidate[],
	limit: number
): Promise<Candidate[]> {
	const recent = await readJson<string[]>(env, RECENT_TYPES_KEY, []);
	const recentCounts = new Map<string, number>();
	for (const key of recent) recentCounts.set(key, (recentCounts.get(key) ?? 0) + 1);

	const bucketOf = (candidate: Candidate) => candidate.id.split('_').slice(-1)[0];

	const ordered = [...candidates].sort(
		(a, b) => (recentCounts.get(bucketOf(a)) ?? 0) - (recentCounts.get(bucketOf(b)) ?? 0)
	);

	const picked: Candidate[] = [];
	const perBucket = new Map<string, number>();
	const perSource = new Map<string, number>();

	for (const candidate of ordered) {
		if (picked.length >= limit) break;

		const bucket = bucketOf(candidate);
		if ((perBucket.get(bucket) ?? 0) >= MAX_PER_TYPE_PER_RUN) continue;
		if ((perSource.get(candidate.source) ?? 0) >= Math.max(1, Math.ceil(limit / 2))) continue;

		picked.push(candidate);
		perBucket.set(bucket, (perBucket.get(bucket) ?? 0) + 1);
		perSource.set(candidate.source, (perSource.get(candidate.source) ?? 0) + 1);
	}

	// relax only the per-source cap; the per-type cap is the whole point of this pass, so a
	// run returns fewer activities rather than five variations of the same thing
	for (const candidate of ordered) {
		if (picked.length >= limit) break;
		if (picked.includes(candidate)) continue;

		const bucket = bucketOf(candidate);
		if ((perBucket.get(bucket) ?? 0) >= MAX_PER_TYPE_PER_RUN) continue;

		picked.push(candidate);
		perBucket.set(bucket, (perBucket.get(bucket) ?? 0) + 1);
	}

	return picked;
}

async function rememberStagedTypes(env: Bindings, staged: Activity[]): Promise<void> {
	if (staged.length === 0) return;

	const recent = await readJson<string[]>(env, RECENT_TYPES_KEY, []);
	for (const activity of staged) {
		for (const type of activity.types ?? []) recent.push(String(type));
	}

	await env.KV.put(RECENT_TYPES_KEY, JSON.stringify(recent.slice(-RECENT_TYPE_WINDOW)));
}

// #endregion

// #region Orchestrator

function passesQualityGate(data: Activity): string | null {
	if ((data.description ?? '').trim().length < MIN_DESCRIPTION_LENGTH) {
		return 'description too short';
	}
	if (!Array.isArray(data.types) || data.types.length === 0) {
		return 'no types';
	}
	// ['OTHER'] is the hardcoded tags-model failure fallback in boat.ts, so it means the
	// classifier died rather than that the activity is genuinely uncategorizable
	if (data.types.length === 1 && String(data.types[0]) === 'OTHER') {
		return 'classifier fell back to OTHER';
	}
	return null;
}

export async function runActivityDiscovery(
	env: Bindings,
	opts: { limit?: number; dryRun?: boolean } = {}
): Promise<DiscoveryResult> {
	const startedAt = Date.now();
	const dryRun = opts.dryRun === true;

	if (!dryRun) {
		const locked = await env.KV.get(LOCK_KEY);
		if (locked) {
			return {
				staged: [],
				candidates: [],
				considered: 0,
				skipped: 'locked',
				funnel: emptyFunnel()
			};
		}
		await env.KV.put(LOCK_KEY, '1', { expirationTtl: LOCK_TTL_SECONDS });
	}

	const { selected, survivors, funnel } = await selectCandidates(env, {
		limit: opts.limit,
		now: startedAt
	});

	if (dryRun) {
		return {
			staged: [],
			candidates: selected.map((candidate) => candidate.id),
			considered: selected.length,
			funnel
		};
	}

	const staged: Activity[] = [];
	let failed = 0;
	let consecutiveAiFailures = 0;

	try {
		for (let i = 0; i < selected.length; i++) {
			const candidate = selected[i];

			if (Date.now() - startedAt > DISCOVERY_DEADLINE_MS) {
				console.warn('Activity discovery: deadline reached, stopping early', {
					staged: staged.length,
					remaining: selected.length - i
				});
				break;
			}

			let data: Activity;
			try {
				// sequential on purpose: each call is up to 3 description attempts plus tags
				data = await createActivityData(candidate.id, candidate.id.replace(/_/g, ' '), env.AI);
			} catch (err) {
				failed++;
				consecutiveAiFailures++;
				// only throws after all 3 temperature-ramped attempts failed validation, which
				// in practice means it is not a describable activity; retrying next hour burns
				// the same calls for the same result
				await addToDiscoveryBlocklist(env, candidate.foldKey, 'rejected_ai', startedAt);
				console.warn('Activity discovery: AI enrichment failed; blocklisting candidate', {
					id: candidate.id,
					source: candidate.source,
					error: err instanceof Error ? err.message : String(err)
				});
				if (consecutiveAiFailures >= MAX_CONSECUTIVE_AI_FAILURES) {
					console.error('Activity discovery: 3 consecutive AI failures, aborting run');
					break;
				}
				continue;
			}
			consecutiveAiFailures = 0;

			const rejection = passesQualityGate(data);
			if (rejection) {
				failed++;
				await addToDiscoveryBlocklist(env, candidate.foldKey, 'rejected_ai', startedAt);
				console.warn('Activity discovery: candidate failed the quality gate', {
					id: candidate.id,
					reason: rejection
				});
				continue;
			}

			try {
				const result = await postStagedActivity(env, data);
				await addToPendingLedger(env, candidate.foldKey, {
					staged_at: startedAt,
					staged_id: result ? String(result.id) : '',
					activity_id: data.id
				});
				// keep the cached catalog current so two runs in one hour cannot collide
				await appendCatalogKey(env, candidate.foldKey);

				if (result) staged.push(data);
			} catch (err) {
				failed++;
				console.error('Activity discovery: failed to stage candidate; continuing', {
					id: candidate.id,
					error: err instanceof Error ? err.message : String(err)
				});
			}
		}
	} finally {
		// advance unconditionally, even on total failure, so a bad run cannot pin the cursor
		const cursor = await readDiscoveryCursor(env);
		const nextOffset = survivors.length ? (cursor.offset + CURSOR_STRIDE) % survivors.length : 0;
		funnel.cursorTo = nextOffset;
		await env.KV.put(
			CURSOR_KEY,
			JSON.stringify({ offset: nextOffset, run: cursor.run + 1, rotated_at: startedAt })
		);
		await env.KV.delete(LOCK_KEY);
	}

	await rememberStagedTypes(env, staged);

	funnel.staged = staged.length;
	funnel.failed = failed;

	// one aggregate line per run; a run legitimately drops a thousand candidates
	console.log('Activity discovery: candidate funnel', funnel);

	return {
		staged,
		candidates: selected.map((candidate) => candidate.id),
		considered: selected.length,
		funnel
	};
}

async function appendCatalogKey(env: Bindings, foldKey: string): Promise<void> {
	try {
		const raw = await env.CACHE.get(CATALOG_CACHE_KEY);
		if (!raw) return;

		const parsed = JSON.parse(raw);
		const keys: string[] = Array.isArray(parsed) ? parsed : (parsed?.value ?? []);
		if (!Array.isArray(keys) || keys.includes(foldKey)) return;

		keys.push(foldKey);
		await env.CACHE.put(
			CATALOG_CACHE_KEY,
			JSON.stringify(Array.isArray(parsed) ? keys : { ...parsed, value: keys }),
			{ expirationTtl: CATALOG_CACHE_TTL }
		);
	} catch {
		// best effort; the pending ledger already blocks a re-propose this hour
	}
}

function emptyFunnel(): DiscoveryFunnel {
	return {
		raw: 0,
		bySource: {},
		normalized: 0,
		afterCrossSource: 0,
		afterBlocklist: 0,
		afterPending: 0,
		afterCatalog: 0,
		afterGenre: 0,
		afterSimilarity: 0,
		selected: 0,
		staged: 0,
		failed: 0,
		cursorFrom: 0,
		cursorTo: 0,
		nextUp: []
	};
}

/**
 * Blocklist, pending ledger, and cursor, for the admin ledger route.
 */
export async function readDiscoveryLedger(env: Bindings): Promise<{
	blocklist: Record<string, BlocklistEntry>;
	pending: Record<string, PendingEntry>;
	cursor: DiscoveryCursor;
}> {
	return {
		blocklist: await readDiscoveryBlocklist(env),
		pending: await readPendingLedger(env),
		cursor: await readDiscoveryCursor(env)
	};
}

// #endregion
