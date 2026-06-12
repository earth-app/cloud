import { Bindings } from '../util/types';

// pulls aggregated request analytics from Cloudflare's GraphQL Analytics API
// and joins it with our content-side metrics so the admin panel can answer
// questions like "which articles are surging vs flopping" without needing
// the operator to flip between CF dashboard and our admin UI.

const CF_GQL_ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';

type GqlRequestsByCountryNode = {
	dimensions: { clientCountryName: string };
	sum: { requests: number };
};

type GqlHttpRequestsByPathNode = {
	dimensions: { clientRequestPath: string };
	sum: { requests: number; bytes: number };
	avg: { sampleInterval: number };
};

type GqlEdgeRequestsByStatusNode = {
	dimensions: { edgeResponseStatus: number };
	sum: { requests: number };
};

type GqlResponse<T> = {
	data: T | null;
	errors?: Array<{ message: string }>;
};

type GqlFetchOptions = {
	zoneTag: string;
	apiToken: string;
	since?: string; // ISO datetime
	until?: string; // ISO datetime
};

function isValidDate(d: Date): boolean {
	return !Number.isNaN(d.getTime());
}

function defaultRange(since?: string, until?: string): { since: string; until: string } {
	const untilParsed = until ? new Date(until) : new Date();
	const now = isValidDate(untilParsed) ? untilParsed : new Date();
	const dayAgo = () => new Date(now.getTime() - 24 * 60 * 60 * 1000);
	const sinceParsed = since ? new Date(since) : dayAgo();
	const start = isValidDate(sinceParsed) ? sinceParsed : dayAgo();
	return { since: start.toISOString(), until: now.toISOString() };
}

async function gqlFetch<T>(
	query: string,
	variables: Record<string, unknown>,
	opts: GqlFetchOptions
): Promise<T | null> {
	const res = await fetch(CF_GQL_ENDPOINT, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${opts.apiToken}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ query, variables })
	});
	if (!res.ok) {
		console.warn('CF Analytics fetch failed', res.status, await res.text());
		return null;
	}
	const json = (await res.json()) as GqlResponse<T>;
	if (json.errors && json.errors.length > 0) {
		console.warn('CF Analytics errors', json.errors.map((e) => e.message).join('; '));
	}
	return json.data;
}

export async function fetchHttpRequestsByCountry(
	opts: GqlFetchOptions
): Promise<GqlRequestsByCountryNode[]> {
	const { since, until } = defaultRange(opts.since, opts.until);
	const query = `
		query ($zoneTag: String!, $since: Time!, $until: Time!) {
			viewer { zones(filter: { zoneTag: $zoneTag }) {
				httpRequests1hGroups(
					limit: 50,
					filter: { datetime_geq: $since, datetime_leq: $until },
					orderBy: [sum_requests_DESC]
				) {
					dimensions { clientCountryName: clientCountryName }
					sum { requests }
				}
			} }
		}`;
	const data = await gqlFetch<{
		viewer: { zones: { httpRequests1hGroups: GqlRequestsByCountryNode[] }[] };
	}>(query, { zoneTag: opts.zoneTag, since, until }, opts);
	return data?.viewer?.zones?.[0]?.httpRequests1hGroups ?? [];
}

export async function fetchHttpRequestsByStatus(
	opts: GqlFetchOptions
): Promise<GqlEdgeRequestsByStatusNode[]> {
	const { since, until } = defaultRange(opts.since, opts.until);
	const query = `
		query ($zoneTag: String!, $since: Time!, $until: Time!) {
			viewer { zones(filter: { zoneTag: $zoneTag }) {
				httpRequestsAdaptiveGroups(
					limit: 50,
					filter: { datetime_geq: $since, datetime_leq: $until },
					orderBy: [sum_requests_DESC]
				) {
					dimensions { edgeResponseStatus }
					sum { requests }
				}
			} }
		}`;
	const data = await gqlFetch<{
		viewer: { zones: { httpRequestsAdaptiveGroups: GqlEdgeRequestsByStatusNode[] }[] };
	}>(query, { zoneTag: opts.zoneTag, since, until }, opts);
	return data?.viewer?.zones?.[0]?.httpRequestsAdaptiveGroups ?? [];
}

export async function fetchTopPaths(
	opts: GqlFetchOptions,
	limit = 25
): Promise<GqlHttpRequestsByPathNode[]> {
	const { since, until } = defaultRange(opts.since, opts.until);
	const query = `
		query ($zoneTag: String!, $since: Time!, $until: Time!, $limit: Int!) {
			viewer { zones(filter: { zoneTag: $zoneTag }) {
				httpRequestsAdaptiveGroups(
					limit: $limit,
					filter: { datetime_geq: $since, datetime_leq: $until, edgeResponseStatus_lt: 400 },
					orderBy: [sum_requests_DESC]
				) {
					dimensions { clientRequestPath }
					sum { requests bytes }
					avg { sampleInterval }
				}
			} }
		}`;
	const data = await gqlFetch<{
		viewer: { zones: { httpRequestsAdaptiveGroups: GqlHttpRequestsByPathNode[] }[] };
	}>(query, { zoneTag: opts.zoneTag, since, until, limit }, opts);
	return data?.viewer?.zones?.[0]?.httpRequestsAdaptiveGroups ?? [];
}

export type AnalyticsSnapshot = {
	since: string;
	until: string;
	by_country: GqlRequestsByCountryNode[];
	by_status: GqlEdgeRequestsByStatusNode[];
	top_paths: GqlHttpRequestsByPathNode[];
	signup_funnel: {
		signup_views: number;
		signups_completed: number;
		verifications_completed: number;
	};
	configured: boolean;
};

export async function getAnalyticsSnapshot(
	env: Bindings,
	since?: string,
	until?: string
): Promise<AnalyticsSnapshot> {
	const apiToken = env.CF_ANALYTICS_TOKEN;
	const zoneTag = env.CF_ZONE_TAG;
	const { since: sinceIso, until: untilIso } = defaultRange(since, until);

	const empty: AnalyticsSnapshot = {
		since: sinceIso,
		until: untilIso,
		by_country: [],
		by_status: [],
		top_paths: [],
		signup_funnel: { signup_views: 0, signups_completed: 0, verifications_completed: 0 },
		configured: false
	};

	if (!apiToken || !zoneTag) {
		// signup-funnel counts come from KV regardless of CF config, so we still try
		empty.signup_funnel = await readSignupFunnel(env);
		return empty;
	}

	const opts: GqlFetchOptions = { apiToken, zoneTag, since: sinceIso, until: untilIso };
	const [byCountry, byStatus, topPaths, funnel] = await Promise.all([
		fetchHttpRequestsByCountry(opts),
		fetchHttpRequestsByStatus(opts),
		fetchTopPaths(opts),
		readSignupFunnel(env)
	]);

	return {
		since: sinceIso,
		until: untilIso,
		by_country: byCountry,
		by_status: byStatus,
		top_paths: topPaths,
		signup_funnel: funnel,
		configured: true
	};
}

// signup funnel counters (tiny KV-backed metric so the admin UI can show conversion
// without depending on a paid Cloudflare account). Mantle2 increments these via
// dedicated cloud endpoints when a user signs up or verifies.
const FUNNEL_KEY = 'admin:funnel:signup';

type SignupFunnel = {
	signup_views: number;
	signups_completed: number;
	verifications_completed: number;
};

async function readSignupFunnel(env: Bindings): Promise<SignupFunnel> {
	const raw = await env.KV.get(FUNNEL_KEY);
	if (!raw) return { signup_views: 0, signups_completed: 0, verifications_completed: 0 };
	try {
		const parsed = JSON.parse(raw) as Partial<SignupFunnel>;
		return {
			signup_views: Number(parsed.signup_views ?? 0),
			signups_completed: Number(parsed.signups_completed ?? 0),
			verifications_completed: Number(parsed.verifications_completed ?? 0)
		};
	} catch {
		return { signup_views: 0, signups_completed: 0, verifications_completed: 0 };
	}
}

export async function bumpSignupFunnel(
	env: Bindings,
	field: keyof SignupFunnel
): Promise<SignupFunnel> {
	const current = await readSignupFunnel(env);
	current[field] = (current[field] ?? 0) + 1;
	await env.KV.put(FUNNEL_KEY, JSON.stringify(current));
	return current;
}
