import { createActivityData } from './boat';
import { getDeniedStagedActivityIds, postStagedActivity } from '../util/mantle2';
import { retrieveActivities } from '../util/mantle2';
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

export const MAX_STAGED_PER_RUN = 5;
export const DISCOVERY_DEADLINE_MS = 120_000;
export const PENDING_TTL_MS = 72 * 60 * 60 * 1000;
export const LOCK_TTL_SECONDS = 600;
export const CATALOG_CACHE_TTL = 3600;
export const CURSOR_STRIDE = MAX_STAGED_PER_RUN * 4;
export const MAX_CONSECUTIVE_AI_FAILURES = 3;
export const MIN_DESCRIPTION_LENGTH = 60;

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

export type BlocklistReason = 'denied' | 'rejected_ai' | 'invalid';
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
	selected: number;
	staged: number;
	failed: number;
	cursorFrom: number;
	cursorTo: number;
	nextUp: string[];
};

export type DiscoveryResult = {
	staged: Activity[];
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
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} ORDER BY DESC(?links) LIMIT 300`,
	// Q47728 hobby, Q968907 outdoor recreation, Q59284991 leisure activity, Q2207288 craft
	hobby: `SELECT ?itemLabel ?links WHERE {
  VALUES ?c { wd:Q47728 wd:Q968907 wd:Q59284991 wd:Q2207288 }
  { ?item wdt:P31 ?c } UNION { ?item wdt:P279 ?c }
  ?item wikibase:sitelinks ?links .
  FILTER(?links >= 10)
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} ORDER BY DESC(?links) LIMIT 300`
};

/**
 * Wikidata SPARQL, the highest-signal source.
 *
 * The non-transitive P31/P279 shape with the materialized `wikibase:sitelinks` count runs
 * in well under a second. Do NOT switch to `wdt:P31/wdt:P279*` with an aggregation - that
 * combination times out at 60s and returns a non-JSON body.
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
 */
export async function fetchWikipediaCategoryCandidates(
	category: string,
	type: 'subcat' | 'page' = 'subcat'
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

	for (const category of DISCOVERY_SEED_CATEGORIES) {
		for (const type of ['subcat', 'page'] as const) {
			record(await fetchWikipediaCategoryCandidates(category, type));
			// polite spacing; trivially inside anonymous limits either way
			await sleep(150);
		}
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
 * Pending submissions, pruned on read at 72h (24h fail-open plus slack).
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
			const activities = await retrieveActivities(env);
			const keys = new Set<string>();

			for (const activity of activities) {
				for (const value of [activity?.id, activity?.name, ...(activity?.aliases ?? [])]) {
					const normalized = normalizeCandidate(String(value ?? ''));
					if (normalized) keys.add(normalized.foldKey);
				}
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
		if (normalized && !blocklist[normalized.foldKey]) {
			blocklist[normalized.foldKey] = { reason: 'denied', at: now };
		}
	}
	if (denied.length > 0) {
		await env.KV.put(BLOCKLIST_KEY, JSON.stringify(blocklist));
	}

	const notBlocked = candidates.filter((candidate) => !blocklist[candidate.foldKey]);
	const pending = await readPendingLedger(env, now);
	const notPending = notBlocked.filter((candidate) => !pending[candidate.foldKey]);

	const catalogKeys = new Set(await readCatalogKeys(env));
	const survivors = notPending
		.filter((candidate) => !catalogKeys.has(candidate.foldKey))
		.sort((a, b) => b.score - a.score || a.foldKey.localeCompare(b.foldKey));

	// every source is stable DESC-by-popularity, so without rotation a transient failure
	// pins the same head-of-list candidates forever
	const cursor = await readDiscoveryCursor(env);
	const start = survivors.length ? cursor.offset % survivors.length : 0;
	const rotated = survivors.slice(start).concat(survivors.slice(0, start));
	const selected = rotated.slice(0, limit);

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
			afterCatalog: survivors.length,
			selected: selected.length,
			staged: 0,
			failed: 0,
			cursorFrom: start,
			cursorTo: start,
			nextUp: rotated.slice(limit, limit + 20).map((candidate) => candidate.id)
		}
	};
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
		return { staged: [], considered: selected.length, funnel };
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

	funnel.staged = staged.length;
	funnel.failed = failed;

	// one aggregate line per run; a run legitimately drops a thousand candidates
	console.log('Activity discovery: candidate funnel', funnel);

	return { staged, considered: selected.length, funnel };
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
