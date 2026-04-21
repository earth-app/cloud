import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	ANALYTICS_MAX_EVENTS_PER_CATEGORY,
	getContentAnalytics,
	getContentAnalyticsByOwner,
	getContentAnalyticsEvents,
	logAnalyticsBatch,
	logEvent,
	logTime
} from '../../src/content/analytics';
import { createMockBindings } from '../helpers/mock-bindings';
import { MockKVNamespace } from '../helpers/mock-kv';

afterEach(() => {
	vi.restoreAllMocks();
});

describe('content analytics', () => {
	it('drops events older than the retention window', async () => {
		const kv = new MockKVNamespace();
		const bindings = createMockBindings({ KV: kv as any });
		const now = 1_750_000_000_000;
		const ninetyOneDaysMs = 91 * 24 * 60 * 60 * 1000;

		vi.spyOn(Date, 'now').mockReturnValue(now);

		await kv.put(
			'content_analytics:article-1',
			JSON.stringify({
				articles_clicked: {
					events: [
						{ user_id: 'u-old', value: 1, timestamp: now - ninetyOneDaysMs },
						{ user_id: 'u-recent', value: 1, timestamp: now - 1_000 }
					],
					total: 2
				}
			})
		);

		await logEvent('articles_clicked', 'article-1', 'u-new', { source: 'spec' }, bindings);

		const events = await getContentAnalyticsEvents('article-1', 'articles_clicked', bindings);
		expect(events).toHaveLength(2);
		expect(events.some((event) => event.user_id === 'u-old')).toBe(false);
		expect(events.some((event) => event.user_id === 'u-new')).toBe(true);
	});

	it('computes timing stats with stable percentiles', async () => {
		const kv = new MockKVNamespace();
		const bindings = createMockBindings({ KV: kv as any });
		const durations = [10, 20, 30, 40, 50];
		let now = 1_000_000;

		vi.spyOn(Date, 'now').mockImplementation(() => {
			now += 1_000;
			return now;
		});

		for (const duration of durations) {
			await logTime('article_read_time', 'article-2', 'u-time', duration, {}, bindings);
		}

		const analytics = await getContentAnalytics('article-2', bindings);
		const category = analytics.article_read_time;

		expect(category).toBeDefined();
		expect(category?.total).toBe(150);
		expect(category?.average).toBe(30);
		expect(category?.p90).toBe(50);
		expect(category?.p99).toBe(50);
	});

	it('caps category growth and sanitizes metadata payloads', async () => {
		const kv = new MockKVNamespace();
		const bindings = createMockBindings({ KV: kv as any });
		const now = 1_760_000_000_000;

		vi.spyOn(Date, 'now').mockReturnValue(now);

		const existingEvents = Array.from(
			{ length: ANALYTICS_MAX_EVENTS_PER_CATEGORY + 250 },
			(_, i) => ({
				user_id: 'u-pre',
				value: 1,
				timestamp: now - (ANALYTICS_MAX_EVENTS_PER_CATEGORY + 250 - i)
			})
		);

		await kv.put(
			'content_analytics:article-3',
			JSON.stringify({
				articles_clicked: {
					events: existingEvents,
					total: existingEvents.length
				}
			})
		);

		const longTitle = 'x'.repeat(5000);
		await logEvent(
			'articles_clicked',
			'article-3',
			'u-new',
			{
				title: longTitle,
				nested: { level: 'deep', value: true }
			},
			bindings
		);

		const analytics = await getContentAnalytics('article-3', bindings);
		const category = analytics.articles_clicked;
		expect(category).toBeDefined();
		if (!category) throw new Error('Expected analytics category');
		expect(category.events.length).toBeLessThanOrEqual(ANALYTICS_MAX_EVENTS_PER_CATEGORY);

		const latest = category.events[category.events.length - 1];
		expect(typeof latest?.metadata?.title).toBe('string');
		expect((latest?.metadata?.title as string).length).toBeLessThan(longTitle.length);
		expect(typeof latest?.metadata?.nested).toBe('string');
		expect(category.total).toBe(category.events.reduce((sum, event) => sum + event.value, 0));
	});

	it('stores owner metadata and returns owner-scoped analytics with aggregate rollups', async () => {
		const kv = new MockKVNamespace();
		const bindings = createMockBindings({ KV: kv as any });

		await logAnalyticsBatch(
			'article-owner-1',
			'reader-1',
			[
				{
					category: 'article_read_time',
					value: 70,
					metadata: { author_id: '101', title: 'A' },
					includeTimingStats: true
				},
				{
					category: 'articles_clicked',
					value: 1,
					metadata: { author_id: '101' }
				}
			],
			bindings
		);

		await logAnalyticsBatch(
			'article-owner-2',
			'reader-2',
			[
				{
					category: 'article_read_time',
					value: 40,
					metadata: { author_id: '101', title: 'B' },
					includeTimingStats: true
				},
				{
					category: 'articles_clicked',
					value: 1,
					metadata: { author_id: '101' }
				}
			],
			bindings
		);

		await logAnalyticsBatch(
			'article-other-owner',
			'reader-3',
			[
				{
					category: 'article_read_time',
					value: 15,
					metadata: { author_id: '202', title: 'Other' },
					includeTimingStats: true
				}
			],
			bindings
		);

		const keyMetadata = await kv.getWithMetadata<unknown, { owner_host?: string }>(
			'content_analytics:article-owner-1'
		);
		expect(keyMetadata.metadata?.owner_host).toBe('101');

		const ownerAnalytics = await getContentAnalyticsByOwner('101', bindings);
		expect(ownerAnalytics.owner_host).toBe('101');
		expect(ownerAnalytics.total_contents).toBe(2);
		expect(ownerAnalytics.analytics).toHaveLength(2);
		expect(ownerAnalytics.content_ids).toEqual(
			expect.arrayContaining(['article-owner-1', 'article-owner-2'])
		);

		expect(ownerAnalytics.aggregate.article_read_time?.total).toBe(110);
		expect(ownerAnalytics.aggregate.article_read_time?.average).toBe(55);
		expect(ownerAnalytics.aggregate.article_read_time?.p90).toBe(70);
		expect(ownerAnalytics.aggregate.article_read_time?.p99).toBe(70);
		expect(ownerAnalytics.aggregate.articles_clicked?.total).toBe(2);
	});

	it('falls back to metadata scanning when owner index keys are absent', async () => {
		const kv = new MockKVNamespace();
		const bindings = createMockBindings({ KV: kv as any });

		await kv.put(
			'content_analytics:legacy-article',
			JSON.stringify({
				articles_clicked: {
					events: [{ user_id: 'reader-9', value: 1, timestamp: Date.now() }],
					total: 1
				}
			}),
			{
				metadata: {
					owner_host: '777',
					content_id: 'legacy-article',
					updated_at: Date.now()
				}
			}
		);

		const ownerAnalytics = await getContentAnalyticsByOwner('777', bindings);
		expect(ownerAnalytics.total_contents).toBe(1);
		expect(ownerAnalytics.content_ids).toEqual(['legacy-article']);
		expect(ownerAnalytics.aggregate.articles_clicked?.total).toBe(1);
	});
});
