import { Bindings } from '../util/types';
import { normalizeId } from '../util/util';

const ANALYTICS_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const ANALYTICS_MAX_EVENTS_PER_CATEGORY = 5000;
const ANALYTICS_MAX_CATEGORY_BYTES = 2 * 1024 * 1024;
const ANALYTICS_MAX_METADATA_FIELDS = 16;
const ANALYTICS_MAX_METADATA_KEY_LENGTH = 64;
const ANALYTICS_MAX_METADATA_VALUE_LENGTH = 256;
const CONTENT_ANALYTICS_KEY_PREFIX = 'content_analytics:';
const OWNER_ANALYTICS_INDEX_PREFIX = 'content_analytics_owner:';
const OWNER_INDEX_LIST_LIMIT = 1000;
const OWNER_ANALYTICS_FETCH_BATCH_SIZE = 25;

export type ContentAnalyticsEvent = {
	user_id: string;
	value: number;
	timestamp: number;
	metadata?: Record<string, any>;
};

export type ContentAnalyticsData = {
	events: ContentAnalyticsEvent[];
	total: number;
	// timing-only fields
	average?: number;
	p90?: number;
	p99?: number;
};

export type ContentAnalytics = Record<string, ContentAnalyticsData>;

export type ContentAnalyticsMetadata = {
	owner_host?: string;
	content_id?: string;
	updated_at?: number;
};

export type ContentAnalyticsCategoryAggregate = {
	total: number;
	average: number;
	p90: number;
	p99: number;
	event_count: number;
	content_count: number;
};

export type OwnerContentAnalyticsResult = {
	owner_host: string;
	content_ids: string[];
	analytics: ContentAnalytics[];
	aggregate: Record<string, ContentAnalyticsCategoryAggregate>;
	total_contents: number;
};

type AnalyticsLogEntry = {
	category: string;
	value: number;
	metadata?: Record<string, any>;
	includeTimingStats?: boolean;
};

type AnalyticsBatchOptions = {
	ownerHost?: string;
};

function buildContentAnalyticsKey(contentId: string) {
	return `${CONTENT_ANALYTICS_KEY_PREFIX}${normalizeId(contentId)}`;
}

function buildOwnerAnalyticsIndexPrefix(ownerHost: string) {
	return `${OWNER_ANALYTICS_INDEX_PREFIX}${normalizeId(ownerHost)}:`;
}

function buildOwnerAnalyticsIndexKey(ownerHost: string, contentId: string) {
	return `${buildOwnerAnalyticsIndexPrefix(ownerHost)}${normalizeId(contentId)}`;
}

function extractOwnerHostFromMetadata(metadata?: Record<string, any>) {
	if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
		return '';
	}

	for (const key of ['owner_host', 'owner_id', 'author_id', 'host_id']) {
		const ownerHost = normalizeId(metadata[key]);
		if (ownerHost) {
			return ownerHost;
		}
	}

	return '';
}

function resolveOwnerHost(
	explicitOwnerHost: unknown,
	entries: AnalyticsLogEntry[],
	existingOwnerHost?: string
) {
	const explicit = normalizeId(explicitOwnerHost);
	if (explicit) {
		return explicit;
	}

	for (const entry of entries) {
		const ownerHost = extractOwnerHostFromMetadata(entry.metadata);
		if (ownerHost) {
			return ownerHost;
		}
	}

	return normalizeId(existingOwnerHost);
}

export async function getContentAnalytics(
	id: string,
	bindings: Bindings
): Promise<ContentAnalytics> {
	const kv = bindings.KV;
	const key = buildContentAnalyticsKey(id);
	const data = await kv.get<ContentAnalytics>(key, 'json');

	if (!data || typeof data !== 'object') {
		return {};
	}

	return data;
}

export async function getContentAnalyticsEvents(
	id: string,
	category: string,
	bindings: Bindings
): Promise<ContentAnalyticsEvent[]> {
	const analytics = await getContentAnalytics(id, bindings);
	return analytics[category]?.events || [];
}

function sanitizeMetadata(metadata: Record<string, any> = {}) {
	if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
		return undefined;
	}

	const sanitized: Record<string, string | number | boolean | null> = {};
	let keptFields = 0;

	for (const [rawKey, rawValue] of Object.entries(metadata)) {
		if (keptFields >= ANALYTICS_MAX_METADATA_FIELDS) {
			break;
		}

		const key = String(rawKey).slice(0, ANALYTICS_MAX_METADATA_KEY_LENGTH);
		if (!key) {
			continue;
		}

		let value: string | number | boolean | null;
		if (rawValue === null) {
			value = null;
		} else if (
			typeof rawValue === 'string' ||
			typeof rawValue === 'number' ||
			typeof rawValue === 'boolean'
		) {
			value =
				typeof rawValue === 'string'
					? rawValue.slice(0, ANALYTICS_MAX_METADATA_VALUE_LENGTH)
					: rawValue;
		} else {
			try {
				value = JSON.stringify(rawValue).slice(0, ANALYTICS_MAX_METADATA_VALUE_LENGTH);
			} catch {
				continue;
			}
		}

		sanitized[key] = value;
		keptFields += 1;
	}

	return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function estimateEventSize(event: ContentAnalyticsEvent) {
	return JSON.stringify(event).length;
}

function trimEventsForStorage(events: ContentAnalyticsEvent[], now: number) {
	const cutoff = now - ANALYTICS_RETENTION_MS;
	let trimmed = events.filter(
		(event) =>
			Number.isFinite(event.timestamp) && event.timestamp >= cutoff && Number.isFinite(event.value)
	);

	if (trimmed.length > ANALYTICS_MAX_EVENTS_PER_CATEGORY) {
		trimmed = trimmed.slice(trimmed.length - ANALYTICS_MAX_EVENTS_PER_CATEGORY);
	}

	let totalBytes = trimmed.reduce((sum, event) => sum + estimateEventSize(event), 0);
	if (totalBytes <= ANALYTICS_MAX_CATEGORY_BYTES) {
		return trimmed;
	}

	let startIndex = 0;
	while (startIndex < trimmed.length && totalBytes > ANALYTICS_MAX_CATEGORY_BYTES) {
		totalBytes -= estimateEventSize(trimmed[startIndex]!);
		startIndex += 1;
	}

	return trimmed.slice(startIndex);
}

function percentile(sortedValues: number[], p: number) {
	if (sortedValues.length === 0) {
		return 0;
	}

	const index = Math.min(
		sortedValues.length - 1,
		Math.max(0, Math.ceil(sortedValues.length * p) - 1)
	);
	return sortedValues[index] || 0;
}

function buildCategoryData(events: ContentAnalyticsEvent[], includeTimingStats: boolean) {
	const total = events.reduce((sum, event) => sum + event.value, 0);

	if (!includeTimingStats) {
		return {
			events,
			total
		};
	}

	const average = events.length > 0 ? total / events.length : 0;
	const sortedValues = events.map((event) => event.value).sort((a, b) => a - b);

	return {
		events,
		total,
		average,
		p90: percentile(sortedValues, 0.9),
		p99: percentile(sortedValues, 0.99)
	};
}

type AggregateAccumulator = {
	total: number;
	event_count: number;
	content_count: number;
	values: number[];
};

function buildOwnerAggregate(
	analyticsList: ContentAnalytics[]
): Record<string, ContentAnalyticsCategoryAggregate> {
	const byCategory = new Map<string, AggregateAccumulator>();

	for (const analytics of analyticsList) {
		for (const [category, data] of Object.entries(analytics)) {
			if (!data || !Array.isArray(data.events)) {
				continue;
			}

			let accumulator = byCategory.get(category);
			if (!accumulator) {
				accumulator = {
					total: 0,
					event_count: 0,
					content_count: 0,
					values: []
				};
				byCategory.set(category, accumulator);
			}

			accumulator.total += Number.isFinite(data.total) ? data.total : 0;
			accumulator.content_count += 1;

			for (const event of data.events) {
				if (!Number.isFinite(event.value)) {
					continue;
				}

				accumulator.event_count += 1;
				accumulator.values.push(event.value);
			}
		}
	}

	const aggregate: Record<string, ContentAnalyticsCategoryAggregate> = {};
	for (const [category, accumulator] of byCategory.entries()) {
		const sortedValues = accumulator.values.sort((a, b) => a - b);
		aggregate[category] = {
			total: accumulator.total,
			average: accumulator.event_count > 0 ? accumulator.total / accumulator.event_count : 0,
			p90: percentile(sortedValues, 0.9),
			p99: percentile(sortedValues, 0.99),
			event_count: accumulator.event_count,
			content_count: accumulator.content_count
		};
	}

	return aggregate;
}

async function listIndexedContentIdsForOwner(ownerHost: string, kv: KVNamespace) {
	const ids = new Set<string>();
	const prefix = buildOwnerAnalyticsIndexPrefix(ownerHost);
	let cursor: string | undefined;

	while (true) {
		const page = await kv.list<{ content_id?: string }>({
			prefix,
			cursor,
			limit: OWNER_INDEX_LIST_LIMIT
		});

		for (const key of page.keys) {
			const fromMetadata = normalizeId(key.metadata?.content_id);
			if (fromMetadata) {
				ids.add(fromMetadata);
				continue;
			}

			const fromKey = key.name.startsWith(prefix) ? key.name.slice(prefix.length) : '';
			const normalized = fromKey.trim();
			if (normalized) {
				ids.add(normalized);
			}
		}

		if (page.list_complete || !page.cursor) {
			break;
		}

		cursor = page.cursor;
	}

	return [...ids];
}

async function listContentIdsForOwnerFromMetadata(ownerHost: string, kv: KVNamespace) {
	const ids = new Set<string>();
	let cursor: string | undefined;

	while (true) {
		const page = await kv.list<ContentAnalyticsMetadata>({
			prefix: CONTENT_ANALYTICS_KEY_PREFIX,
			cursor,
			limit: OWNER_INDEX_LIST_LIMIT
		});

		for (const key of page.keys) {
			const metadataOwner = normalizeId(key.metadata?.owner_host);
			if (metadataOwner !== ownerHost) {
				continue;
			}

			const fromMetadata = key.metadata?.content_id?.trim();
			if (fromMetadata) {
				ids.add(fromMetadata);
				continue;
			}

			if (key.name.startsWith(CONTENT_ANALYTICS_KEY_PREFIX)) {
				ids.add(key.name.slice(CONTENT_ANALYTICS_KEY_PREFIX.length));
			}
		}

		if (page.list_complete || !page.cursor) {
			break;
		}

		cursor = page.cursor;
	}

	return [...ids];
}

export async function getContentAnalyticsByOwner(
	ownerHost: string,
	bindings: Bindings
): Promise<OwnerContentAnalyticsResult> {
	const normalizedOwnerHost = normalizeId(ownerHost);
	if (!normalizedOwnerHost) {
		return {
			owner_host: '',
			content_ids: [],
			analytics: [],
			aggregate: {},
			total_contents: 0
		};
	}

	const kv = bindings.KV;
	let contentIds = await listIndexedContentIdsForOwner(normalizedOwnerHost, kv);

	// Backward-compatibility for records written before owner index keys existed.
	if (contentIds.length === 0) {
		contentIds = await listContentIdsForOwnerFromMetadata(normalizedOwnerHost, kv);
	}

	if (contentIds.length === 0) {
		return {
			owner_host: normalizedOwnerHost,
			content_ids: [],
			analytics: [],
			aggregate: {},
			total_contents: 0
		};
	}

	const analyticsPairs: { contentId: string; analytics: ContentAnalytics }[] = [];
	for (let i = 0; i < contentIds.length; i += OWNER_ANALYTICS_FETCH_BATCH_SIZE) {
		const batch = contentIds.slice(i, i + OWNER_ANALYTICS_FETCH_BATCH_SIZE);
		const resolved = await Promise.all(
			batch.map(async (contentId) => ({
				contentId,
				analytics: await getContentAnalytics(contentId, bindings)
			}))
		);

		for (const item of resolved) {
			if (Object.keys(item.analytics).length === 0) {
				continue;
			}
			analyticsPairs.push(item);
		}
	}

	const analytics = analyticsPairs.map((item) => item.analytics);
	return {
		owner_host: normalizedOwnerHost,
		content_ids: analyticsPairs.map((item) => item.contentId),
		analytics,
		aggregate: buildOwnerAggregate(analytics),
		total_contents: analyticsPairs.length
	};
}

export async function logAnalyticsBatch(
	contentId: string,
	userId: string,
	entries: AnalyticsLogEntry[],
	bindings: Bindings,
	options: AnalyticsBatchOptions = {}
) {
	const normalizedContentId = contentId.trim();
	const normalizedUserId = userId.trim();

	if (!normalizedContentId || !normalizedUserId || entries.length === 0) {
		return;
	}

	const now = Date.now();
	const kv = bindings.KV;
	const key = buildContentAnalyticsKey(normalizedContentId);
	const existing = await kv.getWithMetadata<ContentAnalytics, ContentAnalyticsMetadata>(
		key,
		'json'
	);
	const original =
		existing.value && typeof existing.value === 'object' && !Array.isArray(existing.value)
			? existing.value
			: {};
	const existingMetadata =
		existing.metadata && typeof existing.metadata === 'object' ? existing.metadata : {};
	const updated: ContentAnalytics = { ...original };
	let hasChanges = false;

	for (const entry of entries) {
		if (!entry.category || !Number.isFinite(entry.value)) {
			continue;
		}

		const category = entry.category.trim();
		if (!category) {
			continue;
		}

		const sanitizedMetadata = sanitizeMetadata(entry.metadata || {});
		const event: ContentAnalyticsEvent = {
			user_id: normalizedUserId,
			value: entry.value,
			timestamp: now,
			...(sanitizedMetadata ? { metadata: sanitizedMetadata } : {})
		};

		const currentCategory = updated[category];
		const includeTimingStats =
			Boolean(entry.includeTimingStats) ||
			currentCategory?.average !== undefined ||
			currentCategory?.p90 !== undefined ||
			currentCategory?.p99 !== undefined;

		const mergedEvents = [...(currentCategory?.events || []), event];
		const events = trimEventsForStorage(mergedEvents, now);
		updated[category] = buildCategoryData(events, includeTimingStats);
		hasChanges = true;
	}

	if (!hasChanges) {
		return;
	}

	const ownerHost = resolveOwnerHost(options.ownerHost, entries, existingMetadata.owner_host);
	const metadata: ContentAnalyticsMetadata = {
		...existingMetadata,
		content_id: normalizedContentId,
		updated_at: now
	};

	if (ownerHost) {
		metadata.owner_host = ownerHost;
	}

	await kv.put(key, JSON.stringify(updated), { metadata });

	if (ownerHost && ownerHost !== existingMetadata.owner_host) {
		await kv.put(buildOwnerAnalyticsIndexKey(ownerHost, normalizedContentId), String(now), {
			metadata: {
				content_id: normalizedContentId,
				updated_at: now
			}
		});

		if (existingMetadata.owner_host && existingMetadata.owner_host !== ownerHost) {
			await kv.delete(
				buildOwnerAnalyticsIndexKey(existingMetadata.owner_host, normalizedContentId)
			);
		}
	}
}

export async function logTime(
	category: string,
	contentId: string,
	userId: string,
	seconds: number,
	metadata: Record<string, any> = {},
	bindings: Bindings,
	options: AnalyticsBatchOptions = {}
) {
	await logAnalyticsBatch(
		contentId,
		userId,
		[
			{
				category,
				value: seconds,
				metadata,
				includeTimingStats: true
			}
		],
		bindings,
		options
	);
}

export async function logEvent(
	category: string,
	contentId: string,
	userId: string,
	metadata: Record<string, any> = {},
	bindings: Bindings,
	options: AnalyticsBatchOptions = {}
) {
	await logAnalyticsBatch(
		contentId,
		userId,
		[
			{
				category,
				value: 1,
				metadata
			}
		],
		bindings,
		options
	);
}
