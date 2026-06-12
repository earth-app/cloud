import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	bumpSignupFunnel,
	fetchHttpRequestsByCountry,
	fetchHttpRequestsByStatus,
	fetchTopPaths,
	getAnalyticsSnapshot
} from '../../src/admin/cf-analytics';
import { createMockBindings } from '../helpers/mock-bindings';
import { MockKVNamespace } from '../helpers/mock-kv';

const FUNNEL_KEY = 'admin:funnel:signup';

function gqlResponse(data: unknown, errors?: Array<{ message: string }>): Response {
	return new Response(JSON.stringify(errors ? { data, errors } : { data }), { status: 200 });
}

function silenceWarn() {
	return vi.spyOn(console, 'warn').mockImplementation(() => {});
}

const OPTS = { zoneTag: 'zone-1', apiToken: 'token-1' };

afterEach(() => {
	vi.restoreAllMocks();
});

describe('cf-analytics fetch helpers', () => {
	it('parses requests-by-country nodes from the GraphQL envelope', async () => {
		const node = { dimensions: { clientCountryName: 'US' }, sum: { requests: 42 } };
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			gqlResponse({ viewer: { zones: [{ httpRequests1hGroups: [node] }] } })
		);

		const result = await fetchHttpRequestsByCountry(OPTS);
		expect(result).toEqual([node]);
	});

	it('parses requests-by-status nodes', async () => {
		const node = { dimensions: { edgeResponseStatus: 200 }, sum: { requests: 7 } };
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			gqlResponse({ viewer: { zones: [{ httpRequestsAdaptiveGroups: [node] }] } })
		);

		expect(await fetchHttpRequestsByStatus(OPTS)).toEqual([node]);
	});

	it('passes the limit through to top-paths variables and parses nodes', async () => {
		const node = {
			dimensions: { clientRequestPath: '/v1/users' },
			sum: { requests: 5, bytes: 100 },
			avg: { sampleInterval: 1 }
		};
		const spy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(
				gqlResponse({ viewer: { zones: [{ httpRequestsAdaptiveGroups: [node] }] } })
			);

		const result = await fetchTopPaths(OPTS, 10);
		expect(result).toEqual([node]);

		const body = JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string);
		expect(body.variables.limit).toBe(10);
		expect(body.variables.zoneTag).toBe('zone-1');
	});

	it('returns an empty array when zones are missing from the response', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(gqlResponse({ viewer: { zones: [] } }));
		expect(await fetchHttpRequestsByCountry(OPTS)).toEqual([]);
	});

	it('returns an empty array when data is null', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(gqlResponse(null));
		expect(await fetchTopPaths(OPTS)).toEqual([]);
	});

	it('returns an empty array on a non-OK HTTP response', async () => {
		silenceWarn();
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('forbidden', { status: 403 }));
		expect(await fetchHttpRequestsByStatus(OPTS)).toEqual([]);
	});

	it('still returns data but warns when GraphQL reports errors', async () => {
		const warn = silenceWarn();
		const node = { dimensions: { clientCountryName: 'DE' }, sum: { requests: 1 } };
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			gqlResponse({ viewer: { zones: [{ httpRequests1hGroups: [node] }] } }, [
				{ message: 'rate limited' }
			])
		);

		expect(await fetchHttpRequestsByCountry(OPTS)).toEqual([node]);
		expect(warn).toHaveBeenCalled();
	});

	it('sends the bearer token in the Authorization header', async () => {
		const spy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(gqlResponse({ viewer: { zones: [] } }));

		await fetchHttpRequestsByCountry(OPTS);

		const headers = (spy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
		expect(headers.Authorization).toBe('Bearer token-1');
	});
});

describe('getAnalyticsSnapshot', () => {
	let kv: MockKVNamespace;
	let env: ReturnType<typeof createMockBindings>;

	beforeEach(() => {
		kv = new MockKVNamespace();
		env = createMockBindings({
			KV: kv as any,
			CF_ANALYTICS_TOKEN: undefined,
			CF_ZONE_TAG: undefined
		});
	});

	it('returns an unconfigured snapshot without hitting CF when credentials are missing', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch');
		await kv.put(
			FUNNEL_KEY,
			JSON.stringify({ signup_views: 9, signups_completed: 3, verifications_completed: 1 })
		);

		const snapshot = await getAnalyticsSnapshot(env);

		expect(fetchSpy).not.toHaveBeenCalled();
		expect(snapshot.configured).toBe(false);
		expect(snapshot.by_country).toEqual([]);
		// funnel still comes from KV even when CF is not configured
		expect(snapshot.signup_funnel).toEqual({
			signup_views: 9,
			signups_completed: 3,
			verifications_completed: 1
		});
	});

	it('assembles all sources and reads the funnel from KV when configured', async () => {
		env = createMockBindings({
			KV: kv as any,
			CF_ANALYTICS_TOKEN: 'token-1',
			CF_ZONE_TAG: 'zone-1'
		});
		await kv.put(FUNNEL_KEY, JSON.stringify({ signup_views: 2 }));

		const country = { dimensions: { clientCountryName: 'US' }, sum: { requests: 10 } };
		const status = { dimensions: { edgeResponseStatus: 200 }, sum: { requests: 8 } };
		const path = {
			dimensions: { clientRequestPath: '/v1/x' },
			sum: { requests: 4, bytes: 50 },
			avg: { sampleInterval: 1 }
		};

		vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
			const query = JSON.parse((init as RequestInit).body as string).query as string;
			if (query.includes('httpRequests1hGroups')) {
				return gqlResponse({ viewer: { zones: [{ httpRequests1hGroups: [country] }] } });
			}
			if (query.includes('clientRequestPath')) {
				return gqlResponse({ viewer: { zones: [{ httpRequestsAdaptiveGroups: [path] }] } });
			}
			return gqlResponse({ viewer: { zones: [{ httpRequestsAdaptiveGroups: [status] }] } });
		});

		const snapshot = await getAnalyticsSnapshot(env);

		expect(snapshot.configured).toBe(true);
		expect(snapshot.by_country).toEqual([country]);
		expect(snapshot.by_status).toEqual([status]);
		expect(snapshot.top_paths).toEqual([path]);
		expect(snapshot.signup_funnel).toEqual({
			signup_views: 2,
			signups_completed: 0,
			verifications_completed: 0
		});
	});

	it('passes valid since/until straight through to the snapshot range', async () => {
		const since = '2026-01-01T00:00:00.000Z';
		const until = '2026-01-02T00:00:00.000Z';
		const snapshot = await getAnalyticsSnapshot(env, since, until);
		expect(snapshot.since).toBe(since);
		expect(snapshot.until).toBe(until);
	});

	it('falls back to a default 24h range instead of throwing on invalid dates', async () => {
		const snapshot = await getAnalyticsSnapshot(env, 'garbage', 'also-bad');

		const since = new Date(snapshot.since).getTime();
		const until = new Date(snapshot.until).getTime();
		expect(Number.isNaN(since)).toBe(false);
		expect(Number.isNaN(until)).toBe(false);
		expect(until - since).toBe(24 * 60 * 60 * 1000);
	});

	it('keeps a valid until while defaulting only the invalid since', async () => {
		const until = '2026-03-15T12:00:00.000Z';
		const snapshot = await getAnalyticsSnapshot(env, 'nonsense', until);
		expect(snapshot.until).toBe(until);
		expect(new Date(until).getTime() - new Date(snapshot.since).getTime()).toBe(
			24 * 60 * 60 * 1000
		);
	});
});

describe('bumpSignupFunnel', () => {
	let kv: MockKVNamespace;
	let env: ReturnType<typeof createMockBindings>;

	beforeEach(() => {
		kv = new MockKVNamespace();
		env = createMockBindings({ KV: kv as any });
	});

	it('starts a fresh counter at one and persists it', async () => {
		const result = await bumpSignupFunnel(env, 'signup_views');
		expect(result).toEqual({
			signup_views: 1,
			signups_completed: 0,
			verifications_completed: 0
		});

		const stored = JSON.parse((await kv.get(FUNNEL_KEY)) as string);
		expect(stored.signup_views).toBe(1);
	});

	it('accumulates across calls and only touches the bumped field', async () => {
		await bumpSignupFunnel(env, 'signups_completed');
		await bumpSignupFunnel(env, 'signups_completed');
		const result = await bumpSignupFunnel(env, 'verifications_completed');

		expect(result).toEqual({
			signup_views: 0,
			signups_completed: 2,
			verifications_completed: 1
		});
	});

	it('coerces malformed stored values back to defaults before bumping', async () => {
		await kv.put(FUNNEL_KEY, 'not-json');
		const result = await bumpSignupFunnel(env, 'signup_views');
		expect(result.signup_views).toBe(1);
	});
});
