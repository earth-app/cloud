import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	addToDiscoveryBlocklist,
	collectCandidates,
	DISCOVERY_USER_AGENT,
	fetchTaginfoCandidates,
	fetchWikidataCandidates,
	fetchWikipediaCategoryCandidates,
	MAX_STAGED_PER_RUN,
	filterSemanticDuplicates,
	filterSpecificCandidates,
	isGenreCandidate,
	lexicalSimilarity,
	normalizeCandidate,
	PENDING_TTL_MS,
	readDiscoveryBlocklist,
	readDiscoveryCursor,
	readDiscoveryLedger,
	readPendingLedger,
	removeFromDiscoveryBlocklist,
	runActivityDiscovery,
	selectCandidates,
	TRIGRAM_SIMILARITY_LIMIT
} from '../../src/content/discovery';
import { createMockBindings } from '../helpers/mock-bindings';
import { Activity, Bindings } from '../../src/util/types';

vi.mock('../../src/content/boat', () => ({
	createActivityData: vi.fn(),
	tagsModel: '@cf/meta/llama-3.1-8b-instruct-fp8'
}));

import { createActivityData } from '../../src/content/boat';

const createActivityDataMock = vi.mocked(createActivityData);

function sparqlBody(rows: Array<[string, number]>) {
	return JSON.stringify({
		head: { vars: ['itemLabel', 'links'] },
		results: {
			bindings: rows.map(([label, links]) => ({
				itemLabel: { value: label },
				links: { value: String(links) }
			}))
		}
	});
}

function categoryBody(titles: string[]) {
	return JSON.stringify({ query: { categorymembers: titles.map((title) => ({ title })) } });
}

function taginfoBody(rows: Array<{ value: string; count: number; in_wiki: boolean }>) {
	return JSON.stringify({ total: rows.length, data: rows });
}

function goodActivity(id: string): Activity {
	return {
		id,
		name: id.replace(/_/g, ' '),
		description: 'A sufficiently long generated description of the proposed activity here.',
		aliases: [],
		types: ['SPORT'] as Activity['types'],
		fields: { icon: 'mdi:run' }
	};
}

/**
 * Route every outbound fetch by URL so a test only declares the sources it cares about.
 */
function mockSources(
	options: {
		sport?: Array<[string, number]>;
		hobby?: Array<[string, number]>;
		categories?: string[];
		taginfo?: Array<{ value: string; count: number; in_wiki: boolean }>;
		denied?: string[];
		catalog?: string[];
		stageStatus?: number;
	} = {}
) {
	return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
		const url = typeof input === 'string' ? input : input.toString();

		if (url.includes('query.wikidata.org')) {
			const isSport = decodeURIComponent(url).includes('wd:Q31629');
			return new Response(sparqlBody(isSport ? (options.sport ?? []) : (options.hobby ?? [])), {
				status: 200
			});
		}
		if (url.includes('en.wikipedia.org')) {
			return new Response(categoryBody(options.categories ?? []), { status: 200 });
		}
		if (url.includes('taginfo.openstreetmap.org')) {
			return new Response(taginfoBody(options.taginfo ?? []), { status: 200 });
		}
		if (url.includes('/v2/activities/staged?state=denied')) {
			return new Response(
				JSON.stringify({
					items: (options.denied ?? []).map((id) => ({ activity: { id } }))
				}),
				{ status: 200 }
			);
		}
		if (url.includes('/v2/activities/staged')) {
			const status = options.stageStatus ?? 201;
			if (status === 409) return new Response('conflict', { status: 409 });
			return new Response(JSON.stringify({ id: 7, fails_open: true, submitter_kind: 'cloud' }), {
				status
			});
		}
		if (url.includes('/v2/activities/list')) {
			const items = options.catalog ?? [];
			if (items.length === 0) return new Response('not found', { status: 404 });
			return new Response(JSON.stringify({ items, total: items.length, page: 1, limit: 1000 }), {
				status: 200
			});
		}
		if (url.includes('/v2/activities')) {
			return new Response(JSON.stringify({ items: [], total: 0 }), { status: 200 });
		}

		return new Response('{}', { status: 200 });
	});
}

let env: Bindings;

beforeEach(() => {
	env = createMockBindings();
	createActivityDataMock.mockReset();
	createActivityDataMock.mockImplementation(async (id: string) => goodActivity(id));
	// collapse the 150ms inter-request spacers; 16 category fetches per run otherwise
	// costs ~2.4s of pure sleep in every test that collects candidates
	vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
		fn();
		return 0;
	}) as unknown as typeof setTimeout);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('sources', () => {
	it('builds the sport SPARQL request with the required user agent', async () => {
		const fetchSpy = mockSources({ sport: [['Chess', 269]] });

		const candidates = await fetchWikidataCandidates('sport');

		const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(url).toContain('query.wikidata.org/sparql');
		expect(url).toContain('format=json');
		expect(decodeURIComponent(url)).toContain('wd:Q31629');
		expect((init.headers as Record<string, string>)['User-Agent']).toBe(DISCOVERY_USER_AGENT);
		// a bare or generic agent gets a 403 from Wikimedia
		expect(init.signal).toBeDefined();

		expect(candidates).toEqual([
			{ id: 'chess', foldKey: 'chess', source: 'wikidata_sport', score: 269 }
		]);
	});

	it('uses the hobby entity classes for the hobby query', async () => {
		const fetchSpy = mockSources({ hobby: [['Pottery', 122]] });

		await fetchWikidataCandidates('hobby');

		expect(decodeURIComponent(fetchSpy.mock.calls[0][0] as string)).toContain('wd:Q47728');
	});

	it('returns an empty list when WDQS rate limits, without throwing', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response('rate limited', { status: 429, headers: { 'Retry-After': '30' } })
		);

		await expect(fetchWikidataCandidates('sport')).resolves.toEqual([]);
	});

	it('returns an empty list when WDQS answers with a non-JSON body', async () => {
		// the observed 60s-timeout failure mode returns HTML with a 200
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response('<html>timeout</html>', { status: 200 })
		);

		await expect(fetchWikidataCandidates('sport')).resolves.toEqual([]);
	});

	it('strips the Category: prefix from subcategory titles', async () => {
		mockSources({ categories: ['Category:Beekeeping', 'Category:Cosplay'] });

		const candidates = await fetchWikipediaCategoryCandidates('Hobbies');

		expect(candidates.map((candidate) => candidate.id)).toEqual(['beekeeping', 'cosplay']);
		expect(candidates[0].source).toBe('wikipedia_categories');
	});

	it('filters taginfo values below the count floor or missing from the wiki', async () => {
		mockSources({
			taginfo: [
				{ value: 'soccer', count: 653271, in_wiki: true },
				{ value: 'rare_thing', count: 12, in_wiki: true },
				{ value: 'undocumented', count: 90000, in_wiki: false }
			]
		});

		const candidates = await fetchTaginfoCandidates('sport');

		expect(candidates.map((candidate) => candidate.id)).toEqual(['soccer']);
		expect(candidates[0].score).toBeCloseTo(653.271);
	});
});

describe('normalizeCandidate', () => {
	const cases: Array<[string, string | null]> = [
		['Association football', 'association_football'],
		['Category:Beekeeping', 'beekeeping'],
		['Chess (game)', 'chess'],
		['  Rock Climbing  ', 'rock_climbing'],
		['Pétanque', 'petanque'],
		['List of hobbies', null],
		['Outline of sports', null],
		['1997 World Championships', null],
		['Hobby', null],
		['Sports', null],
		['Sports culture', null],
		['Board games', 'board_games'],
		['Martial arts', 'martial_arts'],
		["Men's Marathon", null],
		['a very long four word phrase', null],
		['The Sport', null],
		['ab', null],
		['', null]
	];

	for (const [input, expected] of cases) {
		it(`maps ${JSON.stringify(input)} to ${JSON.stringify(expected)}`, () => {
			expect(normalizeCandidate(input)?.id ?? null).toBe(expected);
		});
	}

	it('singularizes the last token so plural variants collapse', () => {
		expect(normalizeCandidate('board games')?.foldKey).toBe('board_game');
		expect(normalizeCandidate('board game')?.foldKey).toBe('board_game');
		expect(normalizeCandidate('crafts')?.foldKey).toBe(normalizeCandidate('craft')?.foldKey);
	});
});

describe('cross-source dedup', () => {
	it('keeps the highest scoring entry when two sources agree', async () => {
		mockSources({
			sport: [['Soccer', 10]],
			taginfo: [{ value: 'soccer', count: 653271, in_wiki: true }]
		});

		const { candidates } = await collectCandidates();
		const soccer = candidates.filter((candidate) => candidate.foldKey === 'soccer');

		expect(soccer).toHaveLength(1);
		expect(soccer[0].source).toBe('osm_taginfo');
	});
});

describe('ledgers', () => {
	it('adds, reads, and removes blocklist entries', async () => {
		await addToDiscoveryBlocklist(env, 'chess', 'rejected_ai', 1000);

		expect(await readDiscoveryBlocklist(env)).toEqual({
			chess: { reason: 'rejected_ai', at: 1000 }
		});
		expect(await removeFromDiscoveryBlocklist(env, 'chess')).toBe(true);
		expect(await removeFromDiscoveryBlocklist(env, 'chess')).toBe(false);
		expect(await readDiscoveryBlocklist(env)).toEqual({});
	});

	it('prunes pending entries older than the 72 hour window on read', async () => {
		const now = 10_000_000_000;
		await env.KV.put(
			'activity_discovery:pending',
			JSON.stringify({
				fresh: { staged_at: now - 1000, staged_id: '1', activity_id: 'fresh' },
				stale: { staged_at: now - PENDING_TTL_MS - 1000, staged_id: '2', activity_id: 'stale' }
			})
		);

		const pending = await readPendingLedger(env, now);

		expect(Object.keys(pending)).toEqual(['fresh']);
	});

	it('defaults the cursor and tolerates corrupt JSON', async () => {
		expect(await readDiscoveryCursor(env)).toEqual({ offset: 0, run: 0, rotated_at: 0 });

		await env.KV.put('activity_discovery:cursor', 'not json');
		expect(await readDiscoveryCursor(env)).toEqual({ offset: 0, run: 0, rotated_at: 0 });
	});

	it('exposes all three ledgers together for the admin route', async () => {
		await addToDiscoveryBlocklist(env, 'chess', 'denied', 5);

		const ledger = await readDiscoveryLedger(env);

		expect(ledger.blocklist.chess.reason).toBe('denied');
		expect(ledger.pending).toEqual({});
		expect(ledger.cursor.offset).toBe(0);
	});
});

describe('selection', () => {
	it('excludes blocklisted candidates', async () => {
		mockSources({
			sport: [
				['Chess', 200],
				['Judo', 100]
			]
		});
		await addToDiscoveryBlocklist(env, 'chess', 'rejected_ai');

		const { selected } = await selectCandidates(env);

		expect(selected.map((candidate) => candidate.id)).toEqual(['judo']);
	});

	it('excludes candidates already awaiting review', async () => {
		mockSources({
			sport: [
				['Chess', 200],
				['Judo', 100]
			]
		});
		await env.KV.put(
			'activity_discovery:pending',
			JSON.stringify({
				chess: { staged_at: Date.now(), staged_id: '1', activity_id: 'chess' }
			})
		);

		const { selected } = await selectCandidates(env);

		expect(selected.map((candidate) => candidate.id)).toEqual(['judo']);
	});

	it('merges mantle2 denials into the blocklist so they are never re-proposed', async () => {
		mockSources({
			sport: [
				['Chess', 200],
				['Judo', 100]
			],
			denied: ['chess']
		});

		const { selected } = await selectCandidates(env);

		expect(selected.map((candidate) => candidate.id)).toEqual(['judo']);
		expect((await readDiscoveryBlocklist(env)).chess.reason).toBe('denied');
	});

	it('excludes a candidate whose id is already in the catalog', async () => {
		mockSources({
			sport: [
				['Chess', 200],
				['Judo', 100]
			],
			catalog: ['chess']
		});

		const { selected } = await selectCandidates(env);

		expect(selected.map((candidate) => candidate.id)).toEqual(['judo']);
	});

	it('reads the whole catalog from the paginated id list', async () => {
		const fetchSpy = mockSources({ sport: [['Chess', 200]], catalog: ['chess'] });

		await selectCandidates(env);

		const listCall = fetchSpy.mock.calls.find(([url]) =>
			String(url).includes('/v2/activities/list')
		);
		expect(listCall).toBeDefined();
		expect(String(listCall?.[0])).toContain('limit=1000');
	});

	it('excludes a spelling variant of a catalogued activity via trigram overlap', async () => {
		// the separator is not meaningful; "jiu jitsu" is the catalogued "jiujitsu"
		mockSources({
			sport: [
				['Jiu Jitsu', 200],
				['Judo', 100]
			],
			catalog: ['jiujitsu']
		});

		const { selected } = await selectCandidates(env);

		expect(selected.map((candidate) => candidate.id)).toEqual(['judo']);
	});

	it('keeps distinct compounds that merely share a head word', async () => {
		mockSources({ sport: [['Ice Climbing', 200]], catalog: ['rock_climbing'] });

		const { selected } = await selectCandidates(env);

		expect(selected.map((candidate) => candidate.id)).toEqual(['ice_climbing']);
	});

	it('rotates the survivor list by the stored cursor offset', async () => {
		const rows: Array<[string, number]> = Array.from({ length: 30 }, (_, index) => [
			`sportname${String.fromCharCode(97 + index)}`,
			100 - index
		]);
		mockSources({ sport: rows });

		const first = await selectCandidates(env);
		expect(first.selected).toHaveLength(MAX_STAGED_PER_RUN);

		await env.KV.put(
			'activity_discovery:cursor',
			JSON.stringify({ offset: 20, run: 1, rotated_at: 0 })
		);
		const second = await selectCandidates(env);

		expect(second.selected[0].id).toBe(first.survivors[20].id);
	});
});

describe('runActivityDiscovery', () => {
	it('enriches and stages up to the per-run cap, never more', async () => {
		const rows: Array<[string, number]> = Array.from({ length: 40 }, (_, index) => [
			`sportname${String.fromCharCode(97 + index)}`,
			100 - index
		]);
		mockSources({ sport: rows });

		const result = await runActivityDiscovery(env);

		expect(result.staged).toHaveLength(MAX_STAGED_PER_RUN);
		expect(createActivityDataMock).toHaveBeenCalledTimes(MAX_STAGED_PER_RUN);
		expect(result.funnel.staged).toBe(MAX_STAGED_PER_RUN);
	});

	it('clamps an explicit limit to the per-run cap', async () => {
		mockSources({
			sport: [
				['Chess', 200],
				['Judo', 100]
			]
		});

		await runActivityDiscovery(env, { limit: 99 });

		expect(createActivityDataMock.mock.calls.length).toBeLessThanOrEqual(MAX_STAGED_PER_RUN);
	});

	it('blocklists a candidate whose enrichment throws and keeps going', async () => {
		mockSources({
			sport: [
				['Chess', 200],
				['Judo', 100]
			]
		});
		createActivityDataMock.mockImplementationOnce(async () => {
			throw new Error('all attempts failed validation');
		});

		const result = await runActivityDiscovery(env);

		expect(result.staged.map((activity) => activity.id)).toEqual(['judo']);
		expect((await readDiscoveryBlocklist(env)).chess.reason).toBe('rejected_ai');
	});

	it('aborts the run after three consecutive enrichment failures', async () => {
		const rows: Array<[string, number]> = Array.from({ length: 10 }, (_, index) => [
			`sportname${String.fromCharCode(97 + index)}`,
			100 - index
		]);
		mockSources({ sport: rows });
		createActivityDataMock.mockImplementation(async () => {
			throw new Error('model down');
		});

		const result = await runActivityDiscovery(env);

		expect(result.staged).toHaveLength(0);
		expect(createActivityDataMock).toHaveBeenCalledTimes(3);
	});

	it('rejects an all-OTHER classification, which means the tags model died', async () => {
		mockSources({ sport: [['Chess', 200]] });
		createActivityDataMock.mockImplementation(async (id: string) => ({
			...goodActivity(id),
			types: ['OTHER'] as Activity['types']
		}));

		const result = await runActivityDiscovery(env);

		expect(result.staged).toHaveLength(0);
		expect((await readDiscoveryBlocklist(env)).chess.reason).toBe('rejected_ai');
	});

	it('rejects a description that is too short to be useful', async () => {
		mockSources({ sport: [['Chess', 200]] });
		createActivityDataMock.mockImplementation(async (id: string) => ({
			...goodActivity(id),
			description: 'too short'
		}));

		const result = await runActivityDiscovery(env);

		expect(result.staged).toHaveLength(0);
	});

	it('records a pending entry even when mantle2 answers 409', async () => {
		mockSources({ sport: [['Chess', 200]], stageStatus: 409 });

		const result = await runActivityDiscovery(env);

		expect(result.staged).toHaveLength(0);
		expect(Object.keys(await readPendingLedger(env))).toContain('chess');
	});

	it('advances the cursor even when every candidate fails', async () => {
		const rows: Array<[string, number]> = Array.from({ length: 30 }, (_, index) => [
			`sportname${String.fromCharCode(97 + index)}`,
			100 - index
		]);
		mockSources({ sport: rows });
		createActivityDataMock.mockImplementation(async () => {
			throw new Error('model down');
		});

		await runActivityDiscovery(env);

		expect((await readDiscoveryCursor(env)).offset).toBeGreaterThan(0);
		expect((await readDiscoveryCursor(env)).run).toBe(1);
	});

	it('wraps the cursor modulo the survivor count', async () => {
		mockSources({
			sport: [
				['Chess', 200],
				['Judo', 100]
			]
		});
		await env.KV.put(
			'activity_discovery:cursor',
			JSON.stringify({ offset: 1, run: 4, rotated_at: 0 })
		);

		await runActivityDiscovery(env);

		expect((await readDiscoveryCursor(env)).offset).toBeLessThan(2);
	});

	it('returns immediately when another run holds the lock', async () => {
		await env.KV.put('activity_discovery:lock', '1');
		const fetchSpy = mockSources({ sport: [['Chess', 200]] });

		const result = await runActivityDiscovery(env);

		expect(result.skipped).toBe('locked');
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('releases the lock once the run finishes', async () => {
		mockSources({ sport: [['Chess', 200]] });

		await runActivityDiscovery(env);

		expect(await env.KV.get('activity_discovery:lock')).toBeNull();
	});

	it('a dry run spends no AI budget, posts nothing, and writes nothing', async () => {
		const fetchSpy = mockSources({
			sport: [
				['Chess', 200],
				['Judo', 100]
			]
		});

		const result = await runActivityDiscovery(env, { dryRun: true });

		expect(result.considered).toBeGreaterThan(0);
		expect(result.staged).toHaveLength(0);
		expect(createActivityDataMock).not.toHaveBeenCalled();

		const staged = fetchSpy.mock.calls.filter(([url]) =>
			String(url).includes('/v2/activities/staged?state=denied')
		);
		expect(
			fetchSpy.mock.calls.filter(
				([url, init]) => String(url).endsWith('/v2/activities/staged') && init
			)
		).toHaveLength(0);
		expect(staged.length).toBeLessThanOrEqual(1);

		// the cursor and lock are untouched by a dry run
		expect(await env.KV.get('activity_discovery:cursor')).toBeNull();
		expect(await env.KV.get('activity_discovery:lock')).toBeNull();
	});

	it('reports the funnel with the next candidates queued up', async () => {
		const rows: Array<[string, number]> = Array.from({ length: 12 }, (_, index) => [
			`sportname${String.fromCharCode(97 + index)}`,
			100 - index
		]);
		mockSources({ sport: rows });

		const result = await runActivityDiscovery(env);

		expect(result.funnel.raw).toBeGreaterThan(0);
		expect(result.funnel.bySource.wikidata_sport).toBe(12);
		expect(result.funnel.afterCatalog).toBe(12);
		expect(result.funnel.nextUp.length).toBeGreaterThan(0);
	});
});

describe('genre rejection', () => {
	const genres = [
		'card_game',
		'role_playing_game',
		'board_game',
		'video_game',
		'martial_arts',
		'water_sports',
		'team_sport',
		'garden',
		'music',
		'climbing_equipment',
		'chess_tournament',
		'football_league'
	];

	for (const id of genres) {
		it(`rejects ${id} as a category rather than a practice`, () => {
			expect(isGenreCandidate(id)).toBe(true);
		});
	}

	const practices = [
		'jiujitsu',
		'bouldering',
		'gardening',
		'birdwatching',
		'kitesurfing',
		'calligraphy',
		'sea_kayaking',
		'sourdough_baking'
	];

	for (const id of practices) {
		it(`keeps ${id} as a concrete activity`, () => {
			expect(isGenreCandidate(id)).toBe(false);
		});
	}

	it('drops genre candidates before any AI call and remembers them', async () => {
		mockSources({
			sport: [
				['Card game', 200],
				['Jiujitsu', 100]
			]
		});

		const result = await runActivityDiscovery(env);

		expect(result.staged.map((activity) => activity.id)).toEqual(['jiujitsu']);
		expect((await readDiscoveryBlocklist(env)).card_game.reason).toBe('rejected_genre');
		expect(createActivityDataMock).toHaveBeenCalledTimes(1);
	});
});

describe('specificity gate', () => {
	function aiReturning(text: string) {
		env.AI = {
			run: vi.fn(async (model: string) =>
				String(model).includes('llama-3.1-8b') ? { response: text } : {}
			)
		} as unknown as typeof env.AI;
	}

	it('drops candidates the model calls BROAD', async () => {
		mockSources({
			sport: [
				['Alpha', 200],
				['Beta', 100]
			]
		});
		aiReturning('1. BROAD\n2. SPECIFIC');

		const { kept, rejected } = await filterSpecificCandidates(env, [
			{ id: 'alpha', foldKey: 'alpha', source: 'wikidata_sport', score: 2 },
			{ id: 'beta', foldKey: 'beta', source: 'wikidata_sport', score: 1 }
		]);

		expect(rejected.map((candidate) => candidate.id)).toEqual(['alpha']);
		expect(kept.map((candidate) => candidate.id)).toEqual(['beta']);
	});

	it('keeps everything when the model is unavailable', async () => {
		env.AI = {
			run: vi.fn(async () => {
				throw new Error('model down');
			})
		} as unknown as typeof env.AI;

		const candidates = [
			{ id: 'alpha', foldKey: 'alpha', source: 'wikidata_sport' as const, score: 1 }
		];
		const { kept, rejected } = await filterSpecificCandidates(env, candidates);

		expect(kept).toHaveLength(1);
		expect(rejected).toHaveLength(0);
	});

	it('keeps a candidate whose verdict is missing or unparseable', async () => {
		aiReturning('garbled output');

		const candidates = [
			{ id: 'alpha', foldKey: 'alpha', source: 'wikidata_sport' as const, score: 1 }
		];

		await expect(filterSpecificCandidates(env, candidates)).resolves.toMatchObject({
			kept: candidates,
			rejected: []
		});
	});

	it('sends no request for an empty batch', async () => {
		const run = vi.fn();
		env.AI = { run } as unknown as typeof env.AI;

		await filterSpecificCandidates(env, []);

		expect(run).not.toHaveBeenCalled();
	});
});

describe('similarity helpers', () => {
	it('scores separator-only differences as identical', () => {
		expect(lexicalSimilarity('jiu_jitsu', ['jiujitsu'])).toBe(1);
	});

	it('scores unrelated activities low', () => {
		expect(lexicalSimilarity('chess', ['bouldering'])).toBeLessThan(0.3);
	});

	it('keeps compounds that only share a head word below the limit', () => {
		expect(lexicalSimilarity('ice_climbing', ['rock_climbing'])).toBeLessThan(
			TRIGRAM_SIMILARITY_LIMIT
		);
	});

	it('returns zero against an empty catalog', () => {
		expect(lexicalSimilarity('chess', [])).toBe(0);
	});

	it('drops a semantic duplicate and keeps a distinct candidate', async () => {
		// identical vectors for the candidate and the catalog entry, distinct for the other
		const vectors: Record<string, number[]> = {
			'ocean paddling': [1, 0, 0],
			'sea kayaking': [1, 0, 0],
			chess: [0, 1, 0]
		};
		env.AI = {
			run: vi.fn(async (_model: string, input: { text?: string | string[] }) => ({
				data: (Array.isArray(input.text) ? input.text : [input.text ?? '']).map(
					(text) => vectors[String(text)] ?? [0, 0, 1]
				)
			}))
		} as unknown as typeof env.AI;

		const { kept, rejected } = await filterSemanticDuplicates(
			env,
			[
				{ id: 'ocean_paddling', foldKey: 'ocean_paddling', source: 'wikidata_sport', score: 2 },
				{ id: 'chess', foldKey: 'chess', source: 'wikidata_sport', score: 1 }
			],
			['sea_kayaking']
		);

		expect(rejected.map((candidate) => candidate.id)).toEqual(['ocean_paddling']);
		expect(kept.map((candidate) => candidate.id)).toEqual(['chess']);
	});

	it('keeps everything when embedding fails', async () => {
		env.AI = {
			run: vi.fn(async () => {
				throw new Error('embeddings down');
			})
		} as unknown as typeof env.AI;

		const candidates = [
			{ id: 'chess', foldKey: 'chess', source: 'wikidata_sport' as const, score: 1 }
		];

		await expect(filterSemanticDuplicates(env, candidates, ['bouldering'])).resolves.toMatchObject({
			kept: candidates,
			rejected: []
		});
	});
});

describe('variety', () => {
	it('does not fill a run with a single head word', async () => {
		mockSources({
			sport: [
				['Ice climbing', 210],
				['Rock climbing', 209],
				['Tree climbing', 208],
				['Wall climbing', 207],
				['Chess', 100],
				['Judo', 99]
			]
		});

		const result = await runActivityDiscovery(env);
		const heads = result.staged.map((activity) => activity.id.split('_').slice(-1)[0]);
		const climbing = heads.filter((head) => head === 'climbing').length;

		expect(climbing).toBeLessThanOrEqual(2);
		expect(result.staged.length).toBeGreaterThan(climbing);
	});

	it('records the staged activity types so later runs can vary', async () => {
		mockSources({ sport: [['Jiujitsu', 200]] });

		await runActivityDiscovery(env);

		const recent = JSON.parse((await env.KV.get('activity_discovery:recent_types')) ?? '[]');
		expect(recent).toContain('SPORT');
	});
});
