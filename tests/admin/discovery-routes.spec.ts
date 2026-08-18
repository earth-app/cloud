import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/content/discovery', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../src/content/discovery')>();
	return {
		...actual,
		runActivityDiscovery: vi.fn()
	};
});

import main from '../../src/index';
import {
	addToDiscoveryBlocklist,
	MAX_STAGED_PER_RUN,
	readDiscoveryBlocklist,
	runActivityDiscovery
} from '../../src/content/discovery';
import { createMockBindings } from '../helpers/mock-bindings';
import { Bindings } from '../../src/util/types';

const runDiscoveryMock = vi.mocked(runActivityDiscovery);

let env: Bindings;

function request(path: string, init: RequestInit = {}, authenticated = true): Request {
	const headers = new Headers(init.headers);
	if (authenticated) headers.set('Authorization', 'Bearer test-admin-key');
	if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

	return new Request(`https://cloud.test${path}`, { ...init, headers });
}

async function call(path: string, init: RequestInit = {}, authenticated = true): Promise<Response> {
	const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() };
	return main.fetch(request(path, init, authenticated), env, ctx as never);
}

beforeEach(() => {
	env = createMockBindings();
	runDiscoveryMock.mockReset();
	runDiscoveryMock.mockResolvedValue({
		staged: [],
		candidates: [],
		considered: 3,
		funnel: {
			raw: 10,
			bySource: {},
			normalized: 8,
			afterCrossSource: 8,
			afterBlocklist: 7,
			afterPending: 6,
			afterCatalog: 5,
			afterGenre: 5,
			afterNature: 5,
			natureRejects: {},
			afterSimilarity: 4,
			selected: 3,
			staged: 0,
			failed: 0,
			cursorFrom: 0,
			cursorTo: 20,
			nextUp: []
		}
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('POST /v1/admin/activities/discover', () => {
	it('defaults to a dry run when no body is sent', async () => {
		const response = await call('/v1/admin/activities/discover', { method: 'POST' });

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({ dry_run: true, considered: 3 });
		expect(runDiscoveryMock).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ dryRun: true })
		);
	});

	it('runs for real only when dry_run is explicitly false', async () => {
		await call('/v1/admin/activities/discover', {
			method: 'POST',
			body: JSON.stringify({ dry_run: false })
		});

		expect(runDiscoveryMock).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ dryRun: false })
		);
	});

	it('clamps the limit to the per-run cap', async () => {
		await call('/v1/admin/activities/discover', {
			method: 'POST',
			body: JSON.stringify({ dry_run: false, limit: 99 })
		});

		expect(runDiscoveryMock).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ limit: MAX_STAGED_PER_RUN })
		);
	});

	it('rejects a missing or wrong bearer token', async () => {
		const anonymous = await call('/v1/admin/activities/discover', { method: 'POST' }, false);
		expect(anonymous.status).toBe(401);

		const wrong = await main.fetch(
			new Request('https://cloud.test/v1/admin/activities/discover', {
				method: 'POST',
				headers: { Authorization: 'Bearer nope' }
			}),
			env,
			{ waitUntil: vi.fn(), passThroughOnException: vi.fn() } as never
		);
		expect(wrong.status).toBe(401);
	});

	it('returns 500 when the pipeline throws', async () => {
		runDiscoveryMock.mockRejectedValueOnce(new Error('wikidata down'));

		const response = await call('/v1/admin/activities/discover', { method: 'POST' });

		expect(response.status).toBe(500);
	});

	// the /v1/v1/... trap: routes in app.ts must be declared with bare paths
	it('is not reachable at a doubled /v1 prefix', async () => {
		const response = await call('/v1/v1/admin/activities/discover', { method: 'POST' });

		expect(response.status).toBe(404);
	});
});

describe('/v1/admin/activities/discover/ledger', () => {
	it('returns the blocklist, pending ledger, and cursor', async () => {
		await addToDiscoveryBlocklist(env, 'amateurism', 'denied', 1234);

		const response = await call('/v1/admin/activities/discover/ledger');

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			blocklist: { amateurism: { reason: 'denied', at: 1234 } },
			pending: {},
			cursor: { offset: 0, run: 0 }
		});
	});

	it('removes a blocklisted candidate by key', async () => {
		await addToDiscoveryBlocklist(env, 'amateurism', 'rejected_ai');

		const response = await call('/v1/admin/activities/discover/ledger?key=amateurism', {
			method: 'DELETE'
		});

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ key: 'amateurism', removed: true });
		expect(await readDiscoveryBlocklist(env)).toEqual({});
	});

	it('reports removed:false for a key that was not blocklisted', async () => {
		const response = await call('/v1/admin/activities/discover/ledger?key=nothing', {
			method: 'DELETE'
		});

		await expect(response.json()).resolves.toEqual({ key: 'nothing', removed: false });
	});

	it('requires the key parameter on delete', async () => {
		const response = await call('/v1/admin/activities/discover/ledger', { method: 'DELETE' });

		expect(response.status).toBe(400);
	});
});

describe('POST /v1/admin/activities/audit', () => {
	afterEach(() => vi.unstubAllGlobals());

	const stubCatalogAndWikipedia = () =>
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
			const url = typeof input === 'string' ? input : input.toString();

			if (url.includes('/v2/activities/list')) {
				return new Response(
					JSON.stringify({ items: ['marina', 'bouldering'], total: 2, page: 1, limit: 1000 }),
					{ status: 200 }
				);
			}
			if (url.includes('en.wikipedia.org')) {
				return new Response(
					JSON.stringify({
						query: {
							pages: [
								{ title: 'Marina', pageprops: { 'wikibase-shortdesc': 'Dock with moorings' } },
								{
									title: 'Bouldering',
									pageprops: { 'wikibase-shortdesc': 'Form of rock climbing' }
								}
							]
						}
					}),
					{ status: 200 }
				);
			}
			return new Response('not found', { status: 404 });
		});

	it('requires the admin bearer', async () => {
		expect((await call('/v1/admin/activities/audit', { method: 'POST' }, false)).status).toBe(401);
	});

	it('audits the live catalogue on a bare POST', async () => {
		stubCatalogAndWikipedia();

		const res = await call('/v1/admin/activities/audit', { method: 'POST' });
		expect(res.status).toBe(200);

		const body = (await res.json()) as { checked: number; findings: Array<{ id: string }> };
		expect(body.checked).toBe(2);
		expect(body.findings.map((f) => f.id)).toEqual(['marina']);
	});

	it('audits an explicit id list when one is given', async () => {
		stubCatalogAndWikipedia();

		const res = await call('/v1/admin/activities/audit', {
			method: 'POST',
			body: JSON.stringify({ ids: ['marina'] })
		});

		const body = (await res.json()) as { checked: number };
		expect(body.checked).toBe(1);
	});

	// report-only: an audit must never stage, delete or blocklist
	it('does not write to the blocklist', async () => {
		stubCatalogAndWikipedia();

		await call('/v1/admin/activities/audit', { method: 'POST' });
		expect(await readDiscoveryBlocklist(env)).toEqual({});
	});
});
