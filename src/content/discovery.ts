import { ActivityDataError, createActivityData, tagsModel } from './boat';
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
// must outlive mantle2's 7-day cloud review window, or a still-pending submission gets
// re-proposed before it resolves
export const PENDING_TTL_MS = 8 * 24 * 60 * 60 * 1000;
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
	| 'wikidata_sport'
	| 'wikidata_hobby'
	| 'wikidata_practice'
	| 'wikipedia_categories'
	| 'wikipedia_lists'
	| 'wikivoyage_activities'
	| 'osm_taginfo';

/**
 * Hand-curated Wikipedia list and outline articles.
 *
 * A category walk collects whatever anyone ever filed under a category, which is how a bridge in
 * Tokyo and a genus of cichlid ended up in the catalogue. These pages are lists a person wrote and
 * maintains, so nearly every blue link on them is genuinely a thing people do.
 *
 * Titles are pinned because most obvious guesses do not exist -- "List of hobbies", "List of
 * crafts", "List of outdoor activities" and "List of individual sports" are all redlinks.
 */
export const WIKIPEDIA_LIST_PAGES = [
	'List of sports',
	'Outline of sports',
	'List of dances',
	'List of martial arts',
	'List of water sports',
	'List of winter sports',
	'List of racket sports',
	'Outline of crafts',
	'List of art media',
	'List of board games',
	'List of games',
	'Hobby',
	// five of the twelve pages above are sports indexes, which is most of why a live queue of 629
	// came back 406 sports. each of these was checked against the live api rather than guessed
	'Outline of food preparation',
	'Outline of music',
	'Outline of performing arts',
	'Outline of the visual arts',
	'Index of gardening articles',
	'List of card games by number of cards'
];

export type Candidate = {
	id: string;
	foldKey: string;
	source: DiscoverySource;
	score: number;
};

export type BlocklistReason =
	'denied' | 'rejected_ai' | 'rejected_genre' | 'rejected_nature' | 'rejected_similar' | 'invalid';
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
	afterNature: number;
	// what the short-description screen decided the rejects actually were
	natureRejects: Record<string, number>;
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
	// practice classes yield the most specific names, so they win ties; curated lists rank with
	// them because a human maintains the membership
	wikidata_practice: 4,
	wikipedia_lists: 4,
	wikidata_sport: 3,
	wikidata_hobby: 3,
	osm_taginfo: 2,
	wikivoyage_activities: 2,
	wikipedia_categories: 1
};

const SPARQL_QUERIES: Record<'sport' | 'hobby' | 'practice', string> = {
	// Q61065 water sport, Q11417 martial art, Q877729 handicraft; these classes are where the
	// named practices live (Muay Thai, skimboarding, pyrography) rather than the genres
	practice: `SELECT ?itemLabel ?links WHERE {
  VALUES ?c { wd:Q61065 wd:Q11417 wd:Q877729 }
  { ?item wdt:P31 ?c } UNION { ?item wdt:P279 ?c }
  ?item wikibase:sitelinks ?links .
  FILTER(?links >= 10)
  FILTER NOT EXISTS { ?sub wdt:P279 ?item }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} ORDER BY DESC(?links) LIMIT 300`,
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
export async function fetchWikidataCandidates(
	kind: 'sport' | 'hobby' | 'practice'
): Promise<Candidate[]> {
	const source = `wikidata_${kind}` as DiscoverySource;
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

export const WIKIVOYAGE_SEED_CATEGORIES = ['Activities', 'Outdoor life', 'Sports', 'Hiking'];

/**
 * Wikivoyage activity categories.
 *
 * Travel writing names things people do rather than things people study, so this yields
 * candidates the encyclopedia categories miss (geocaching, urban sketching, agritourism).
 */
export async function fetchWikivoyageCandidates(): Promise<Candidate[]> {
	const candidates: Candidate[] = [];

	for (const category of WIKIVOYAGE_SEED_CATEGORIES) {
		const url =
			`https://en.wikivoyage.org/w/api.php?action=query&list=categorymembers` +
			`&cmtitle=${encodeURIComponent(`Category:${category}`)}` +
			`&cmtype=page&cmlimit=200&format=json&formatversion=2`;

		try {
			const res = await fetch(url, {
				headers: { 'User-Agent': DISCOVERY_USER_AGENT },
				signal: AbortSignal.timeout(15_000)
			});
			if (!res.ok) continue;

			const body = await res.json<{ query?: { categorymembers?: Array<{ title?: string }> } }>();
			for (const member of body?.query?.categorymembers ?? []) {
				const normalized = normalizeCandidate(member.title ?? '');
				if (!normalized) continue;
				candidates.push({ ...normalized, source: 'wikivoyage_activities', score: 1 });
			}
		} catch (err) {
			console.warn('Activity discovery: wikivoyage walk failed', {
				category,
				error: err instanceof Error ? err.message : String(err)
			});
		}

		await sleep(150);
	}

	return candidates;
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
 * Blue links on a curated list or outline article.
 *
 * @param page article title, from {@link WIKIPEDIA_LIST_PAGES}
 */
export async function fetchWikipediaListCandidates(page: string): Promise<Candidate[]> {
	const url =
		`https://en.wikipedia.org/w/api.php?action=parse&prop=links&format=json` +
		`&formatversion=2&redirects=1&page=${encodeURIComponent(page)}`;

	try {
		const res = await fetch(url, {
			headers: { 'User-Agent': DISCOVERY_USER_AGENT },
			signal: AbortSignal.timeout(15_000)
		});
		if (!res.ok) return [];

		const body = await res.json<{
			parse?: { links?: Array<{ title?: string; ns?: number; exists?: boolean }> };
		}>();

		const candidates: Candidate[] = [];
		for (const link of body?.parse?.links ?? []) {
			// ns 0 is article space; a redlink names nothing that can be screened
			if (link.ns !== 0 || !link.exists) continue;
			const normalized = normalizeCandidate(link.title ?? '');
			if (!normalized) continue;
			candidates.push({ ...normalized, source: 'wikipedia_lists', score: 1 });
		}

		return candidates;
	} catch (err) {
		console.warn(`Activity discovery: list walk failed for ${page}`, {
			error: err instanceof Error ? err.message : String(err)
		});
		return [];
	}
}

/**
 * OSM taginfo; real-world sport vocabulary already in snake_case.
 *
 * `sport` only. The `leisure` key was removed: its values name FACILITIES, not practices, and it
 * is where `marina`, `slipway`, `pitch` and `sauna` entered the live catalogue.
 */
export async function fetchTaginfoCandidates(key: 'sport'): Promise<Candidate[]> {
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
	record(await fetchWikidataCandidates('practice'));
	record(await fetchWikivoyageCandidates());

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

	for (const page of WIKIPEDIA_LIST_PAGES) {
		record(await fetchWikipediaListCandidates(page));
		await sleep(150);
	}

	record(await fetchTaginfoCandidates('sport'));

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

// a person who does the thing is not the thing; "aquarist" reached the AI and burned three
// description attempts before failing, because no valid activity description exists for it.
// -er is deliberately absent: it would reject "soccer".
const AGENT_NOUN_SUFFIXES = [
	'ist',
	'ists',
	'eer',
	'eers',
	'ographer',
	'ographers',
	'ologist',
	'ologists',
	'phile',
	'philes',
	'man',
	'men',
	'woman',
	'women',
	'person',
	'people',
	// trades: watchmaker, coppersmith, shipwright, fishmonger -- all reached the live catalogue
	'smith',
	'smiths',
	'maker',
	'makers',
	'wright',
	'wrights',
	'monger',
	'mongers'
];
const AGENT_NOUN_WORDS = new Set([
	'keeper',
	'keepers',
	'player',
	'players',
	'collector',
	'collectors',
	'enthusiast',
	'enthusiasts',
	'fancier',
	'fanciers',
	'rider',
	'riders',
	'racer',
	'racers',
	'gardener',
	'gardeners',
	'dealer',
	'dealers',
	'guide',
	'guides',
	'coach',
	'coaches',
	'instructor',
	'instructors',
	'trainer',
	'trainers',
	'artisan',
	'artisans',
	'crafter',
	'crafters',
	'builder',
	'builders',
	'handler',
	'handlers',
	'breeder',
	'breeders'
]);

// a preposition in the middle joins a practice to a place or a qualifier, which is what produces
// "tennis in bosnia" and "sport in wales" off the category walk
const MEDIAL_PREPOSITIONS = new Set(['in', 'of', 'at', 'by', 'for', 'on', 'from', 'with']);

function isAgentNoun(word: string): boolean {
	if (AGENT_NOUN_WORDS.has(word)) return true;
	// "artist" and "florist" are short enough that the suffix is most of the word; require
	// a real stem so "list" and "mist" survive
	return AGENT_NOUN_SUFFIXES.some(
		(suffix) => word.endsWith(suffix) && word.length >= suffix.length + 4
	);
}

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
	// "tennis in bosnia", "history of chess" -- a practice bound to a place or a qualifier
	if (words.slice(1).some((word) => MEDIAL_PREPOSITIONS.has(word))) return null;
	// reject only when the whole phrase is generic; "board games" and "martial arts" are
	// real activities even though they contain a stopword
	if (words.every((word) => STOPWORDS.has(word))) return null;
	// the head noun carries the meaning; "aquarist" and "stamp collector" are both people
	if (isAgentNoun(words[words.length - 1])) return null;
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

// #endregion

// #region Short description gate

/**
 * What a candidate turned out to name, once its Wikipedia short description was read.
 *
 * `unknown` is not a rejection: plenty of real practices have no short description, and those
 * fall through to the AI gate as before.
 */
export type CandidateNature =
	| 'activity'
	| 'person'
	| 'place'
	| 'organism'
	| 'substance'
	| 'object'
	| 'organization'
	| 'work'
	| 'rule'
	| 'competition_class'
	| 'unsuitable'
	| 'ambiguous'
	| 'unknown';

export type CandidateEvidence = {
	foldKey: string;
	title: string;
	shortDescription: string | null;
	nature: CandidateNature;
};

/** wikipedia caps a titles= batch at 50 for anonymous callers */
export const SHORTDESC_BATCH = 50;

/**
 * Turn an activity id back into the Wikipedia title it most likely came from.
 *
 * Only the first letter is cased; the API normalizes the rest and follows redirects, so
 * "milk_glass" resolves to "Milk glass" without a title-case guess per word.
 */
export function candidateTitle(id: string): string {
	const words = id.replace(/_/g, ' ').trim();
	return words.charAt(0).toUpperCase() + words.slice(1);
}

// a short description is a noun phrase, so the HEAD carries the meaning and the rest is
// modification. matching keywords anywhere in the string reads "Variant of football played on a
// court" as a PLACE and "Method of cooking food" as a SUBSTANCE, which is how an earlier pass of
// this gate rejected futsal and baking.
const NATURE_LEXICON: Array<[CandidateNature, string[]]> = [
	[
		'activity',
		[
			'sport',
			'sports',
			'boardsport',
			'watersport',
			'motorsport',
			'pastime',
			'hobby',
			'discipline',
			'exercise',
			'workout',
			'dance',
			'martial',
			'gymnastics',
			'athletics',
			'race',
			'racing',
			'competition',
			'tournament',
			'recreation',
			'activity',
			'pursuit',
			'game',
			'games',
			'event'
		]
	],
	[
		'organism',
		[
			'genus',
			'species',
			'subspecies',
			'taxon',
			'breed',
			'variety',
			'varieties',
			'cultivar',
			'plant',
			'tree',
			'flower',
			'animal',
			'fish',
			'bird',
			'insect',
			'fungus',
			'mushroom',
			'mammal',
			'reptile',
			'carp'
		]
	],
	[
		'person',
		[
			'artisan',
			'craftsman',
			'craftsperson',
			'profession',
			'occupation',
			'practitioner',
			'worker',
			'specialist',
			'trader',
			'dealer',
			'merchant',
			'labourer',
			'laborer',
			'job',
			'role',
			'title',
			'person',
			'people',
			'someone',
			'individual'
		]
	],
	[
		'place',
		[
			'dock',
			'harbor',
			'harbour',
			'marina',
			'ramp',
			'building',
			'structure',
			'venue',
			'facility',
			'museum',
			'park',
			'bridge',
			'arena',
			'stadium',
			'rink',
			'bathhouse',
			'hall',
			'clubhouse',
			'region',
			'city',
			'town',
			'village',
			'county',
			'province',
			'island',
			'mountain',
			'river',
			'lake',
			'neighborhood',
			'neighbourhood',
			'district',
			'settlement',
			'establishment',
			'premises'
		]
	],
	[
		'substance',
		[
			'mixture',
			'resin',
			'compound',
			'chemical',
			'substance',
			'alloy',
			'mineral',
			'pigment',
			'dye',
			'fibre',
			'fiber',
			'thread',
			'yarn',
			'fabric',
			'textile',
			'material',
			'clay',
			'wax',
			'glass',
			'drug',
			'beverage',
			'ingredient'
		]
	],
	[
		'object',
		[
			'tool',
			'device',
			'instrument',
			'machine',
			'equipment',
			'implement',
			'apparatus',
			'utensil',
			'brand',
			'product',
			'trademark',
			'manufacturer',
			'component',
			'accessory',
			'garment',
			'clothing',
			'furniture',
			'vehicle',
			'weapon',
			'toy'
		]
	],
	[
		'organization',
		[
			'organization',
			'organisation',
			'company',
			'corporation',
			'association',
			'society',
			'institute',
			'institution',
			'federation',
			'foundation',
			'charity',
			'nonprofit',
			'agency',
			'league',
			'club',
			'team'
		]
	],
	[
		'work',
		[
			'film',
			'movie',
			'novel',
			'book',
			'album',
			'song',
			'magazine',
			'newspaper',
			'comic',
			'manga',
			'anime',
			'character',
			'series',
			'franchise',
			'subgenre'
		]
	],
	[
		// something that happens INSIDE an activity rather than being one. "Play in American
		// football", "Formation in American football", "Offensive strategy in gridiron football"
		'rule',
		[
			'rule',
			'ruleset',
			'penalty',
			'foul',
			'infraction',
			'violation',
			'sanction',
			'play',
			'formation',
			'lineup',
			'scheme',
			'strategy',
			'tactic',
			'manoeuvre',
			'maneuver',
			'stance',
			'grip',
			'stroke',
			'shot',
			'throw',
			'kick',
			'serve',
			'score',
			'statistic',
			'metric',
			'notation',
			'terminology',
			'term',
			'jargon'
		]
	],
	[
		// a division of an activity the catalog already has, rather than an activity
		'competition_class',
		[
			'classification',
			'division',
			'bracket',
			'weight-class',
			'championship',
			'championships',
			'olympics',
			'paralympics',
			'medal',
			'qualifier',
			'playoff',
			'playoffs'
		]
	]
];

// a taxonomic head names a bucket, so the complement after "of" carries the real nature:
// "Form of rock climbing" is an activity, "Type of bathhouse" is a place.
const TAXONOMIC_HEADS = new Set([
	'form',
	'type',
	'kind',
	'sort',
	'variant',
	'variation',
	'style',
	'genre',
	'category',
	'class',
	'group',
	'branch',
	'subset',
	'example',
	'member',
	'part',
	'element',
	'aspect',
	'set',
	'collection'
]);

// a process head IS the activity, whatever it operates on. "Study of plant life" is a practice
// even though its complement is an organism, and reading it the other way rejected botany.
const PROCESS_HEADS = new Set([
	'act',
	'action',
	'art',
	'craft',
	'practice',
	'method',
	'technique',
	'process',
	'skill',
	'use',
	'study',
	'pursuit',
	'discipline',
	'training',
	'performance'
]);

// where the head phrase stops and modification begins. "and"/"or" are deliberately absent: they
// join compound modifiers, and breaking on them read "Outdoor team stick and ball game" as an
// ORGANIZATION off the word "team".
const HEAD_STOPWORDS = new Set([
	'of',
	'in',
	'on',
	'at',
	'for',
	'with',
	'from',
	'by',
	'to',
	'that',
	'which',
	'who',
	'whom',
	'whose',
	'where',
	'when',
	'used',
	'played',
	'performed',
	'made',
	'produced',
	'found',
	'based'
]);

const ARTICLES = new Set(['a', 'an', 'the']);

// the last two catch pages that are ABOUT a word rather than about a practice, e.g. ebeniste's
// 'French loan-word meaning "cabinet-maker"'
const AMBIGUOUS_MARKERS =
	/\b(topics? referred to|disambiguation|may refer to|index of|commonly refers|name shared by|loan-?word|surname|given name)\b/i;

// content the catalog does not carry regardless of how well-formed the entry is. checked against
// the name AND the short description, since "Peep Show" reads clean on its own
const UNSUITABLE_MARKERS =
	/\b(erotic\w*|striptease|stripper|pornograph\w*|fetish|bdsm|peep[\s-]?show|lap[\s-]?dance|prostitut\w*|cockfight\w*|bullfight\w*|dogfight\w*|bear[\s-]?baiting|blood[\s-]?sport|sports?[\s-]?betting|gambling|wagering|bookmaking)\b/i;

// a leading modifier naming a competition class of an activity the catalog already has;
// the short description of "Paralympic Football" is "Paralympic sport", which reads as an
// activity, so the NAME is the only witness for this class
const COMPETITION_CLASS_MODIFIERS = new Set([
	'paralympic',
	'paralympics',
	'olympic',
	'olympics',
	'commonwealth',
	'collegiate',
	'intercollegiate',
	'professional',
	'amateur',
	'junior',
	'senior',
	'masters',
	'youth',
	'varsity'
]);

/** the leading noun phrase, lowercased, with articles removed */
export function headPhrase(text: string): string[] {
	const words = text
		.toLowerCase()
		.replace(/[^a-z\s-]/g, ' ')
		.split(/\s+/)
		.filter(Boolean)
		.filter((word) => !ARTICLES.has(word));

	const head: string[] = [];
	for (const word of words) {
		if (HEAD_STOPWORDS.has(word)) break;
		head.push(word);
	}

	// an all-stopword opening (rare) means there is no head to read
	return head;
}

/** the phrase after the first "of", which is what a generic head actually refers to */
function complementPhrase(text: string): string {
	const match = /\bof\s+(.*)$/i.exec(text);
	return match ? match[1]! : '';
}

/**
 * Match a head phrase against the lexicons, rightmost word first.
 *
 * English compounds put the head on the right: "insect mounting tool" is a TOOL, not an insect.
 * Scanning left to right classified it as an organism.
 */
function lexiconMatch(words: string[]): CandidateNature | null {
	for (let i = words.length - 1; i >= 0; i--) {
		for (const [nature, terms] of NATURE_LEXICON) {
			if (terms.includes(words[i]!)) return nature;
		}
	}
	return null;
}

// -ing words that name a thing rather than a practice; the stem test alone lets these through
const GERUND_EXCEPTIONS = new Set([
	// "str"/"spr" are not verb stems, but they clear the length test the same way "box" does
	'string',
	'spring',
	'building',
	'clothing',
	'ceiling',
	'herring',
	'lightning',
	'housing',
	'bedding',
	'wedding',
	'sibling',
	'dumpling',
	'earring',
	'awning',
	'bearing',
	'casing',
	'coating',
	'lining',
	'tubing',
	'wiring',
	'siding',
	'roofing',
	'flooring',
	'opening',
	'meaning',
	'feeling',
	'setting',
	'morning',
	'evening'
]);

/** whether a single word reads as a gerund, i.e. the name of an action */
function isGerund(word: string | undefined): boolean {
	if (!word || !word.endsWith('ing') || word.length < 6) return false;
	if (GERUND_EXCEPTIONS.has(word)) return false;

	// "string" and "spring" leave "str"/"spr", which are not verb stems; "boxing" leaves "box"
	return word.slice(0, -3).length >= 3;
}

/**
 * Whether the head of a phrase is a gerund.
 *
 * Reads the RIGHTMOST word, matching where English puts the head: "rock climbing" is climbing,
 * and "insect mounting tool" is a tool rather than a mounting.
 */
function isGerundHead(words: string[]): boolean {
	return isGerund(words[words.length - 1]);
}

/**
 * Classify a candidate from its Wikipedia short description.
 *
 * Deterministic on purpose. The AI gate that used to carry this alone is a single 8B call that
 * fails open, so an outage let every facility, taxon and profession through; a short description
 * is a human-written one-line definition and answers the question outright.
 *
 * Reads the HEAD of the noun phrase, recursing past a generic head ("form of", "type of") into
 * its complement, because that is where the meaning actually sits.
 *
 * @param shortDescription wikipedia's `wikibase-shortdesc` page property
 */
export function classifyShortDescription(shortDescription: string | null): CandidateNature {
	const text = (shortDescription ?? '').trim();
	if (!text) return 'unknown';

	if (UNSUITABLE_MARKERS.test(text)) return 'unsuitable';
	if (AMBIGUOUS_MARKERS.test(text)) return 'ambiguous';

	const head = headPhrase(text);
	if (head.length === 0) return 'unknown';

	// a named local institution: "Living agricultural museum in Tucson, Arizona"
	if (/\bin [A-Z][a-z]+/.test(text) && lexiconMatch(head) === 'place') return 'place';

	if (isGerundHead(head)) return 'activity';

	// "Study of plant life" is a practice, not an organism
	if (head.some((word) => PROCESS_HEADS.has(word))) return 'activity';

	const isTaxonomic = head.some((word) => TAXONOMIC_HEADS.has(word));
	if (!isTaxonomic) {
		const direct = lexiconMatch(head);
		if (direct) return direct;
	}

	// "Form of rock climbing" -> read "rock climbing"; one level only, since a second "of" is
	// almost always a qualifier rather than a new subject
	const complement = complementPhrase(text);
	if (complement) {
		const complementHead = headPhrase(complement);
		if (isGerundHead(complementHead)) return 'activity';
		if (complementHead.some((word) => PROCESS_HEADS.has(word))) return 'activity';

		const nested = lexiconMatch(complementHead);
		if (nested) return nested;
	}

	return 'unknown';
}

// a practice-shaped name: "sailing", "soap making", "pigeon keeping", "flower pressing"
const PRACTICE_ID_TAILS = /(?:athlon|ology)$/;

/**
 * Whether the candidate's own name already says it is a practice.
 *
 * Wikipedia redirects the practice to the object it involves -- "Soap making" lands on "Soap",
 * "Pressure cooking" on "Pressure cooker", "Yoyoing" on "Yo-yo" -- so the short description ends
 * up describing a substance or a toy. The candidate's own name is the more reliable witness in
 * exactly those cases.
 *
 * @param id activity id, snake_case
 */
export function hasPracticeShapedName(id: string): boolean {
	const words = id.split('_').filter(Boolean);
	const head = words[words.length - 1] ?? '';

	return isGerund(head) || (head.length >= 6 && PRACTICE_ID_TAILS.test(head));
}

/**
 * Whether the name is a competition class of an activity rather than an activity.
 *
 * A modifier alone is not enough: "Olympics" on its own is the games, and a one-word name has no
 * activity being qualified.
 *
 * @param id activity id, snake_case
 */
export function namesCompetitionClass(id: string): boolean {
	const words = id.split('_').filter(Boolean);
	if (words.length < 2) return false;

	return COMPETITION_CLASS_MODIFIERS.has(words[0]!.toLowerCase());
}

/**
 * Whether the short description describes the thing that was actually asked about.
 *
 * A redirect that changes the subject makes the description evidence about something else, so a
 * rejection drawn from it is not trustworthy. Compared loosely: "Milk glass" -> "Milk glass" is
 * the same subject, "Luthiery" -> "Luthier" is not.
 *
 * @param id activity id that was looked up
 * @param resolvedTitle title wikipedia actually answered with
 */
export function isSameSubject(id: string, resolvedTitle: string): boolean {
	const fold = (value: string) =>
		value
			.toLowerCase()
			.replace(/[^a-z0-9]/g, '')
			.replace(/(?:ing|ery|ry|s)$/, '');

	return fold(id) === fold(resolvedTitle);
}

/**
 * Classify a candidate using its name and its short description together.
 *
 * @param id activity id
 * @param shortDescription wikipedia short description, if any
 * @param resolvedTitle title wikipedia resolved the id to
 */
export function classifyCandidate(
	id: string,
	shortDescription: string | null,
	resolvedTitle?: string
): CandidateNature {
	const name = id.replace(/_/g, ' ');

	// ahead of everything: an unsuitable entry is unsuitable however well it is described, and
	// "Pole Dancing" would otherwise be settled as an activity by its gerund name
	if (UNSUITABLE_MARKERS.test(name) || UNSUITABLE_MARKERS.test(shortDescription ?? '')) {
		return 'unsuitable';
	}

	// "Paralympic Nordic Skiing" is gerund-headed, so this has to come before the practice check
	if (namesCompetitionClass(id)) return 'competition_class';

	// the name settles it before the description gets a chance to describe something else
	if (hasPracticeShapedName(id)) return 'activity';

	const nature = classifyShortDescription(shortDescription);

	// a rejection sourced from a different subject is not evidence about this candidate
	if (
		isRejectedNature(nature) &&
		resolvedTitle !== undefined &&
		!isSameSubject(id, resolvedTitle)
	) {
		return 'unknown';
	}

	return nature;
}

/**
 * Natures that are never worth an AI call or an admin's review time.
 *
 * `ambiguous` is deliberately NOT here. It says the TITLE is ambiguous, not that the candidate is
 * junk: wushu, taiji, sanda, barre, hearts, cross country, dulcimer and aerial acrobatics all
 * have disambiguation pages and are all real practices. Rejecting on it cost eight good
 * activities to catch three bad ones, so it is surfaced for review instead.
 */
const REJECTED_NATURES = new Set<CandidateNature>([
	'person',
	'place',
	'organism',
	'substance',
	'object',
	'organization',
	'work',
	'rule',
	'competition_class',
	'unsuitable'
]);

export function isRejectedNature(nature: CandidateNature): boolean {
	return REJECTED_NATURES.has(nature);
}

/**
 * Read short descriptions for a batch of candidates.
 *
 * One request per 50 candidates, no key, ~250ms. Redirects and capitalization are normalized
 * server-side, so `milk_glass` finds "Milk glass" without a client-side title-case guess.
 *
 * @param ids activity ids to look up
 */
export async function fetchShortDescriptions(
	ids: string[]
): Promise<Map<string, { title: string; shortDescription: string | null }>> {
	const out = new Map<string, { title: string; shortDescription: string | null }>();
	if (ids.length === 0) return out;

	for (let offset = 0; offset < ids.length; offset += SHORTDESC_BATCH) {
		const batch = ids.slice(offset, offset + SHORTDESC_BATCH);
		// the api normalizes and redirects, so the response title rarely matches what was sent;
		// this maps it back
		const requested = new Map(batch.map((id) => [candidateTitle(id).toLowerCase(), id]));

		const url =
			`https://en.wikipedia.org/w/api.php?action=query&prop=pageprops` +
			`&ppprop=wikibase_item%7Cwikibase-shortdesc&redirects=1&format=json&formatversion=2` +
			`&titles=${encodeURIComponent(batch.map(candidateTitle).join('|'))}`;

		try {
			const res = await fetch(url, {
				headers: { 'User-Agent': DISCOVERY_USER_AGENT },
				signal: AbortSignal.timeout(15_000)
			});
			if (!res.ok) continue;

			const body = await res.json<{
				query?: {
					pages?: Array<{ title?: string; missing?: boolean; pageprops?: Record<string, string> }>;
					normalized?: Array<{ from?: string; to?: string }>;
					redirects?: Array<{ from?: string; to?: string }>;
				};
			}>();

			// walk normalization then redirects so a final title resolves back to the id asked for
			const backlink = new Map<string, string>();
			for (const [key, id] of requested) backlink.set(key, id);
			for (const step of [...(body?.query?.normalized ?? []), ...(body?.query?.redirects ?? [])]) {
				const from = (step.from ?? '').toLowerCase();
				const to = (step.to ?? '').toLowerCase();
				const id = backlink.get(from);
				if (id && to) backlink.set(to, id);
			}

			for (const page of body?.query?.pages ?? []) {
				const id = backlink.get((page.title ?? '').toLowerCase());
				if (!id || page.missing) continue;
				out.set(id, {
					title: page.title ?? '',
					shortDescription: page.pageprops?.['wikibase-shortdesc'] ?? null
				});
			}
		} catch (err) {
			console.warn('Activity discovery: short description lookup failed', {
				error: err instanceof Error ? err.message : String(err)
			});
		}

		if (offset + SHORTDESC_BATCH < ids.length) await sleep(150);
	}

	return out;
}

/**
 * Screen candidates against their short descriptions.
 *
 * Fails OPEN per candidate: anything with no short description keeps going, so a Wikipedia outage
 * degrades precision back to what it was rather than halting discovery.
 *
 * @param candidates candidates to screen
 */
export async function screenByShortDescription(candidates: Candidate[]): Promise<{
	kept: Candidate[];
	rejected: Array<{ candidate: Candidate; evidence: CandidateEvidence }>;
	evidence: Map<string, CandidateEvidence>;
}> {
	const evidence = new Map<string, CandidateEvidence>();
	if (candidates.length === 0) return { kept: [], rejected: [], evidence };

	const descriptions = await fetchShortDescriptions(candidates.map((c) => c.id));

	const kept: Candidate[] = [];
	const rejected: Array<{ candidate: Candidate; evidence: CandidateEvidence }> = [];

	for (const candidate of candidates) {
		const found = descriptions.get(candidate.id);
		const nature = classifyCandidate(candidate.id, found?.shortDescription ?? null, found?.title);
		const entry: CandidateEvidence = {
			foldKey: candidate.foldKey,
			title: found?.title ?? candidateTitle(candidate.id),
			shortDescription: found?.shortDescription ?? null,
			nature
		};
		evidence.set(candidate.foldKey, entry);

		if (isRejectedNature(nature)) rejected.push({ candidate, evidence: entry });
		else kept.push(candidate);
	}

	return { kept, rejected, evidence };
}

// #endregion

// #region Genre rejection (ai)

const SPECIFICITY_SYSTEM = `You decide whether a term names something a person can actually GO AND DO.

Reply with one line per input, in order, formatted exactly as:
<index>. <verdict>

Verdicts:
ACTIVITY - a specific thing a person practices, plays, makes or does.
  jiujitsu, bouldering, sourdough baking, birdwatching, kitesurfing, calligraphy, plogging
BROAD - a category or genre that contains activities but is not one itself.
  card game, role playing game, martial arts, water sports, team sport, the arts
THING - an object, material, tool, brand, place, building, organism, person, profession or
  organisation. It may be USED IN an activity, but it is not an activity.
  water bottle, milk glass, propolis, marina, slipway, koi, watchmaker, insect pins, fimo
HYPERLOCAL - tied to one named place, club or event rather than being a practice in its own right.
  tennis in bosnia, mission garden, artisans asylum

If a term is a thing rather than something you do, answer THING even when it sounds interesting.
No other text.`;

/**
 * Batch-classify candidates as a practice, a genre, a thing, or a local curiosity.
 *
 * One small-model call for the whole batch. Fails OPEN (keeps everything) so an AI outage
 * degrades variety rather than halting the pipeline -- which is safe now only because the
 * deterministic short-description screen already ran ahead of it.
 *
 * @param env worker bindings
 * @param candidates shortlisted candidates
 * @param evidence short descriptions, used to ground the model in what the term actually means
 */
export async function filterSpecificCandidates(
	env: Bindings,
	candidates: Candidate[],
	evidence?: Map<string, CandidateEvidence>
): Promise<{ kept: Candidate[]; rejected: Candidate[] }> {
	if (candidates.length === 0) return { kept: [], rejected: [] };

	// the short description is a human-written definition; without it the model is guessing at
	// what a word like "picot" or "marudai" even refers to
	const listing = candidates
		.map((candidate, index) => {
			const description = evidence?.get(candidate.foldKey)?.shortDescription;
			const label = candidate.id.replace(/_/g, ' ');
			return description ? `${index + 1}. ${label} (${description})` : `${index + 1}. ${label}`;
		})
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
		// SPECIFIC is still accepted so an older reply shape does not read as a rejection
		const match = line.match(/^\s*(\d+)\s*[.):]\s*(ACTIVITY|SPECIFIC|BROAD|THING|HYPERLOCAL)\b/i);
		if (match) {
			const verdict = match[2].toUpperCase();
			verdicts.set(Number(match[1]), verdict === 'ACTIVITY' || verdict === 'SPECIFIC');
		}
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
 * Pending submissions, pruned on read at 8 days (the 7-day cloud window plus slack).
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

/**
 * Take the shortlist round-robin across sources instead of straight off the top.
 *
 * Every source is ranked by popularity, and sports articles carry the most sitelinks, so a flat
 * `slice(0, N)` handed the paid gates a shortlist that was mostly sports; a live queue of 629 came
 * back 406 of them. Order within each source is preserved, so the best of each still wins.
 *
 * @param candidates ranked candidates, best first
 * @param limit how many to take
 */
export function interleaveBySource(candidates: Candidate[], limit: number): Candidate[] {
	const bySource = new Map<DiscoverySource, Candidate[]>();
	for (const candidate of candidates) {
		const bucket = bySource.get(candidate.source);
		if (bucket) bucket.push(candidate);
		else bySource.set(candidate.source, [candidate]);
	}

	const queues = [...bySource.values()];
	const picked: Candidate[] = [];

	// a source that runs dry drops out rather than holding its slot open
	for (let round = 0; picked.length < limit; round++) {
		let tookAny = false;
		for (const queue of queues) {
			if (picked.length >= limit) break;
			const next = queue[round];
			if (!next) continue;
			picked.push(next);
			tookAny = true;
		}
		if (!tookAny) break;
	}

	return picked;
}

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
	const shortlist = interleaveBySource(rotated, SPECIFICITY_BATCH);

	// deterministic and free, so it runs before anything billed; one request for the batch
	const {
		kept: notThings,
		rejected: thingRejects,
		evidence
	} = await screenByShortDescription(shortlist);

	const { kept: specific, rejected: broad } = await filterSpecificCandidates(
		env,
		notThings,
		evidence
	);
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
			...thingRejects.map(({ candidate }) => [candidate, 'rejected_nature'] as const),
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
			afterNature: notThings.length,
			natureRejects: thingRejects.reduce<Record<string, number>>((counts, { evidence: entry }) => {
				counts[entry.nature] = (counts[entry.nature] ?? 0) + 1;
				return counts;
			}, {}),
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

				// blocklist only when the model answered and the answer was unusable three
				// times, which means the candidate is not a describable activity. an outage
				// says nothing about the candidate, so leave it for the next run.
				const permanent = err instanceof ActivityDataError && err.reason === 'invalid_candidate';
				if (permanent) {
					await addToDiscoveryBlocklist(env, candidate.foldKey, 'rejected_ai', startedAt);
				}

				console.warn(
					permanent
						? 'Activity discovery: candidate is not describable; blocklisting'
						: 'Activity discovery: AI unavailable; leaving candidate for the next run',
					{
						id: candidate.id,
						source: candidate.source,
						error: err instanceof Error ? err.message : String(err)
					}
				);

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
		afterNature: 0,
		natureRejects: {},
		afterSimilarity: 0,
		selected: 0,
		staged: 0,
		failed: 0,
		cursorFrom: 0,
		cursorTo: 0,
		nextUp: []
	};
}

// #region Catalog audit

export type AuditRecommendation = 'delete' | 'review';

export type AuditFinding = {
	id: string;
	nature: CandidateNature;
	title: string;
	short_description: string | null;
	recommendation: AuditRecommendation;
	reason: string;
};

export type CatalogAudit = {
	checked: number;
	counts: Record<string, number>;
	findings: AuditFinding[];
	generated_at: string;
};

const NATURE_REASONS: Record<CandidateNature, string> = {
	activity: 'reads as a practice',
	person: 'names a person or profession, not something to do',
	place: 'names a place or facility, not something to do',
	organism: 'names a living thing, not something to do',
	substance: 'names a material or substance, not something to do',
	object: 'names an object, tool or brand, not something to do',
	organization: 'names an organisation, not something to do',
	work: 'names a creative work, not something to do',
	rule: 'names a rule, play or formation inside an activity, not the activity',
	competition_class: 'names a competition class of an activity the catalog already covers',
	unsuitable: 'adult, gambling or blood-sport content the catalog does not carry',
	ambiguous: 'the title is ambiguous; confirm which meaning was intended',
	unknown: 'no short description available to screen against'
};

/**
 * Screen the entire live catalog and report what looks wrong.
 *
 * Report-only by design: nothing is deleted, blocklisted or staged. Users already have these
 * activities on their profiles, so removal is an admin decision rather than a cron's.
 *
 * `delete` findings are the ones the short-description screen is confident about; `review`
 * findings are titles that resolve to a disambiguation page, where the activity is usually real
 * but the id is ambiguous.
 *
 * @param env worker bindings
 * @param ids optional id list, defaulting to the live catalog
 */
export async function auditActivityCatalog(env: Bindings, ids?: string[]): Promise<CatalogAudit> {
	const catalog = ids ?? (await retrieveActivityIds(env));
	const descriptions = await fetchShortDescriptions(catalog);

	const counts: Record<string, number> = {};
	const findings: AuditFinding[] = [];

	for (const id of catalog) {
		const found = descriptions.get(id);
		const nature = classifyCandidate(id, found?.shortDescription ?? null, found?.title);
		counts[nature] = (counts[nature] ?? 0) + 1;

		if (nature !== 'ambiguous' && !isRejectedNature(nature)) continue;

		findings.push({
			id,
			nature,
			title: found?.title ?? candidateTitle(id),
			short_description: found?.shortDescription ?? null,
			recommendation: isRejectedNature(nature) ? 'delete' : 'review',
			reason: NATURE_REASONS[nature]
		});
	}

	// the confident rejections first; an admin working top-down should hit the clear cases first
	findings.sort(
		(a, b) =>
			Number(b.recommendation === 'delete') - Number(a.recommendation === 'delete') ||
			a.nature.localeCompare(b.nature) ||
			a.id.localeCompare(b.id)
	);

	return {
		checked: catalog.length,
		counts,
		findings,
		generated_at: new Date().toISOString()
	};
}

// #endregion

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
