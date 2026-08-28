import { beforeEach, describe, expect, it, vi } from 'vitest';

var mocks: {
	retrieveLeaderboard: ReturnType<typeof vi.fn>;
	createPrompt: ReturnType<typeof vi.fn>;
	postPrompt: ReturnType<typeof vi.fn>;
	findArticle: ReturnType<typeof vi.fn>;
	createArticle: ReturnType<typeof vi.fn>;
	createArticleQuiz: ReturnType<typeof vi.fn>;
	postArticle: ReturnType<typeof vi.fn>;
	retrieveEvents: ReturnType<typeof vi.fn>;
	createEvent: ReturnType<typeof vi.fn>;
	postEvent: ReturnType<typeof vi.fn>;
	runActivityDiscovery: ReturnType<typeof vi.fn>;
};

function createMocks() {
	return {
		retrieveLeaderboard: vi.fn(),
		createPrompt: vi.fn(),
		postPrompt: vi.fn(),
		findArticle: vi.fn(),
		createArticle: vi.fn(),
		createArticleQuiz: vi.fn(),
		wasArticlePublished: vi.fn(async () => false),
		rememberPublishedArticle: vi.fn(async () => undefined),
		postArticle: vi.fn(),
		retrieveEvents: vi.fn(),
		createEvent: vi.fn(),
		postEvent: vi.fn(),
		runActivityDiscovery: vi.fn()
	};
}

vi.mock('../src/user/journies', () => ({
	TOP_LEADERBOARD_COUNT: 250,
	retrieveLeaderboard: (mocks ??= createMocks()).retrieveLeaderboard
}));

vi.mock('../src/content/boat', () => ({
	createPrompt: (mocks ??= createMocks()).createPrompt,
	findArticle: (mocks ??= createMocks()).findArticle,
	createArticle: (mocks ??= createMocks()).createArticle,
	createArticleQuiz: (mocks ??= createMocks()).createArticleQuiz,
	wasArticlePublished: (mocks ??= createMocks()).wasArticlePublished,
	rememberPublishedArticle: (mocks ??= createMocks()).rememberPublishedArticle,
	retrieveEvents: (mocks ??= createMocks()).retrieveEvents,
	createEvent: (mocks ??= createMocks()).createEvent,
	postEvent: (mocks ??= createMocks()).postEvent
}));

vi.mock('../src/content/discovery', () => ({
	runActivityDiscovery: (mocks ??= createMocks()).runActivityDiscovery
}));

vi.mock('../src/util/mantle2', () => ({
	postArticle: (mocks ??= createMocks()).postArticle,
	postPrompt: (mocks ??= createMocks()).postPrompt
}));

import scheduled from '../src/scheduled';
import { createMockBindings } from './helpers/mock-bindings';
import { addBadgeProgress } from '../src/user/badges';

beforeEach(() => {
	vi.clearAllMocks();
	mocks ??= createMocks();
	mocks.retrieveLeaderboard.mockResolvedValue([]);
	mocks.createPrompt.mockResolvedValue('Prompt?');
	mocks.postPrompt.mockResolvedValue({ id: 'p1' });
	mocks.runActivityDiscovery.mockResolvedValue({ staged: [], considered: 0, funnel: {} });
	mocks.findArticle.mockResolvedValue([
		[
			{
				title: 'Best',
				author: 'A',
				source: 'S',
				keywords: ['x'],
				date: '2026-01-01',
				links: {},
				content: 'content'
			},
			{
				title: 'Worst',
				author: 'A',
				source: 'S',
				keywords: ['x'],
				date: '2026-01-01',
				links: {},
				content: 'content'
			}
		],
		['SCIENCE']
	]);
	mocks.createArticle.mockResolvedValue({
		title: 'Generated',
		description: 'D',
		content: 'C',
		ocean: {
			title: 'O',
			author: 'A',
			source: 'S',
			keywords: [],
			date: '2026-01-01',
			links: {}
		}
	});
	mocks.createArticleQuiz.mockResolvedValue([]);
	mocks.postArticle.mockResolvedValue({ id: 'a1' });
	mocks.retrieveEvents.mockResolvedValue([
		{ entry: { name: 'Event One' }, date: new Date('2026-01-01T00:00:00.000Z') }
	]);
	mocks.createEvent.mockResolvedValue({
		name: 'Event One',
		description: 'Desc',
		activities: [],
		type: 'ONLINE',
		date: Date.now(),
		end_date: Date.now() + 1000,
		visibility: 'PUBLIC',
		fields: {}
	});
	mocks.postEvent.mockResolvedValue({ id: '10', name: 'Event One', description: 'Desc' });
});

describe('scheduled', () => {
	it('caches all leaderboard journey types on 4-hour cron', async () => {
		await scheduled({ cron: '0 */4 * * *' } as ScheduledController, createMockBindings(), {
			waitUntil: () => {}
		} as any);

		expect(mocks.retrieveLeaderboard).toHaveBeenCalledTimes(3);
		expect(mocks.retrieveLeaderboard).toHaveBeenNthCalledWith(
			1,
			'article',
			250,
			expect.anything(),
			expect.anything()
		);
	});

	it('creates and posts a prompt on hourly cron', async () => {
		await scheduled({ cron: '0 * * * *' } as ScheduledController, createMockBindings(), {
			waitUntil: () => {}
		} as any);

		expect(mocks.createPrompt).toHaveBeenCalledTimes(1);
		expect(mocks.postPrompt).toHaveBeenCalledWith('Prompt?', expect.anything());
	});

	it('creates and posts generated articles on 4-hour cron', async () => {
		await scheduled({ cron: '0 */4 * * *' } as ScheduledController, createMockBindings(), {
			waitUntil: () => {}
		} as any);

		expect(mocks.findArticle).toHaveBeenCalledTimes(1);
		expect(mocks.createArticle).toHaveBeenCalledTimes(2);
		expect(mocks.createArticleQuiz).toHaveBeenCalledTimes(2);
		expect(mocks.postArticle).toHaveBeenCalledTimes(2);
		expect(mocks.rememberPublishedArticle).toHaveBeenCalledTimes(2);
	});

	// two different sources rewritten into one headline is what put "Glaciers will vanish by 2050"
	// in the live catalogue twice
	it('does not post an article whose generated title was already published', async () => {
		mocks.wasArticlePublished.mockResolvedValue(true);

		await scheduled({ cron: '0 */4 * * *' } as ScheduledController, createMockBindings(), {
			waitUntil: () => {}
		} as any);

		expect(mocks.createArticle).toHaveBeenCalledTimes(2);
		expect(mocks.postArticle).not.toHaveBeenCalled();
		expect(mocks.rememberPublishedArticle).not.toHaveBeenCalled();
	});

	it('revokes badges invalidated by duplicate tracker cleanup on article cron', async () => {
		const kv = createMockBindings().KV as any;

		await kv.put(
			'user:badge_tracker:42:articles_read',
			JSON.stringify([
				{ date: 1, value: 'article-1' },
				{ date: 2, value: 'article-2' },
				{ date: 3, value: 'article-3' },
				{ date: 4, value: 'article-4' },
				{ date: 5, value: 'article-5' },
				{ date: 6, value: 'article-6' },
				{ date: 7, value: 'article-7' },
				{ date: 8, value: 'article-8' },
				{ date: 9, value: 'article-9' },
				{ date: 10, value: 'article-1' }
			])
		);
		await kv.put('user:badge:42:article_enthusiast', JSON.stringify({ granted_at: 1000 }));

		await addBadgeProgress('42', 'articles_read_time', 1800, kv as any, {
			article: { id: 'article-a' }
		});
		await addBadgeProgress('42', 'articles_read_time', 1800, kv as any, {
			article: { id: 'article-b' }
		});
		await kv.put('user:badge:42:bookworm', JSON.stringify({ granted_at: 2000 }));

		await scheduled(
			{ cron: '0 */4 * * *' } as ScheduledController,
			createMockBindings({ KV: kv }),
			{
				waitUntil: () => {}
			} as any
		);

		expect(await kv.get('user:badge:42:article_enthusiast')).toBeNull();
		expect(await kv.get('user:badge:42:bookworm')).not.toBeNull();

		const dedupedTracker = await kv.get('user:badge_tracker:42:articles_read', 'json');
		expect(dedupedTracker?.map((entry: any) => entry.value)).toEqual([
			'article-1',
			'article-2',
			'article-3',
			'article-4',
			'article-5',
			'article-6',
			'article-7',
			'article-8',
			'article-9'
		]);

		const readTimeTracker = await kv.get('user:badge_tracker:42:articles_read_time', 'json');
		expect(readTimeTracker).toHaveLength(2);
	});

	it('continues creating remaining events when one entry fails', async () => {
		mocks.retrieveEvents.mockResolvedValue([
			{ entry: { name: 'Bad Event' }, date: new Date('2026-01-01T00:00:00.000Z') },
			{ entry: { name: 'Good Event' }, date: new Date('2026-01-02T00:00:00.000Z') }
		]);
		mocks.createEvent.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({
			name: 'Good Event',
			description: 'Desc',
			activities: [],
			type: 'ONLINE',
			date: Date.now(),
			end_date: Date.now() + 1000,
			visibility: 'PUBLIC',
			fields: {}
		});

		await scheduled({ cron: '0 0 */4 * *' } as ScheduledController, createMockBindings(), {
			waitUntil: () => {}
		} as any);

		expect(mocks.createEvent).toHaveBeenCalledTimes(2);
		expect(mocks.postEvent).toHaveBeenCalledTimes(1);
	});

	it('continues posting remaining events when one postEvent call fails', async () => {
		mocks.retrieveEvents.mockResolvedValue([
			{ entry: { name: 'First Event' }, date: new Date('2026-01-01T00:00:00.000Z') },
			{ entry: { name: 'Second Event' }, date: new Date('2026-01-02T00:00:00.000Z') }
		]);
		mocks.createEvent
			.mockResolvedValueOnce({
				name: 'First Event',
				description: 'Desc',
				activities: [],
				type: 'ONLINE',
				date: Date.now(),
				end_date: Date.now() + 1000,
				visibility: 'PUBLIC',
				fields: {}
			})
			.mockResolvedValueOnce({
				name: 'Second Event',
				description: 'Desc',
				activities: [],
				type: 'ONLINE',
				date: Date.now(),
				end_date: Date.now() + 1000,
				visibility: 'PUBLIC',
				fields: {}
			});
		mocks.postEvent.mockRejectedValueOnce(new Error('post failed')).mockResolvedValueOnce({
			id: '20',
			name: 'Second Event',
			description: 'Desc'
		});

		await scheduled({ cron: '0 0 */4 * *' } as ScheduledController, createMockBindings(), {
			waitUntil: () => {}
		} as any);

		expect(mocks.createEvent).toHaveBeenCalledTimes(2);
		expect(mocks.postEvent).toHaveBeenCalledTimes(2);
	});

	it('skips postEvent when createEvent returns null and continues next entries', async () => {
		mocks.retrieveEvents.mockResolvedValue([
			{ entry: { name: 'Skipped Event' }, date: new Date('2026-01-01T00:00:00.000Z') },
			{ entry: { name: 'Good Event' }, date: new Date('2026-01-02T00:00:00.000Z') }
		]);
		mocks.createEvent.mockResolvedValueOnce(null).mockResolvedValueOnce({
			name: 'Good Event',
			description: 'Desc',
			activities: [],
			type: 'ONLINE',
			date: Date.now(),
			end_date: Date.now() + 1000,
			visibility: 'PUBLIC',
			fields: {}
		});

		await scheduled({ cron: '0 0 */4 * *' } as ScheduledController, createMockBindings(), {
			waitUntil: () => {}
		} as any);

		expect(mocks.createEvent).toHaveBeenCalledTimes(2);
		expect(mocks.postEvent).toHaveBeenCalledTimes(1);
		expect(mocks.postEvent).toHaveBeenCalledWith(
			expect.objectContaining({ name: 'Good Event' }),
			expect.anything(),
			expect.anything()
		);
	});

	it('expires stale pending content reports on the daily cron', async () => {
		const bindings = createMockBindings();
		const kv = bindings.KV as any;

		const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
		await kv.put('report:index:pending', JSON.stringify(['rid1']));
		await kv.put(
			'report:item:rid1',
			JSON.stringify({
				id: 'rid1',
				content_type: 'prompt',
				content_id: 'c1',
				reason: 'spam',
				source: 'user',
				status: 'pending',
				report_count: 1,
				created_at: eightDaysAgo,
				updated_at: eightDaysAgo
			})
		);
		await kv.put('report:content:prompt:c1', 'rid1');

		await scheduled({ cron: '0 2 * * *' } as ScheduledController, bindings, {
			waitUntil: () => {}
		} as any);

		expect((await kv.get('report:item:rid1', 'json')).status).toBe('expired');
		expect(await kv.get('report:index:pending')).toBeNull();
		expect(await kv.get('report:content:prompt:c1')).toBeNull();
		expect(await kv.get('report:index:expired')).toBe(JSON.stringify(['rid1']));
	});

	it('logs when no cron branch matches', async () => {
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

		await scheduled({ cron: '*/5 * * * *' } as ScheduledController, createMockBindings(), {
			waitUntil: () => {}
		} as any);

		expect(spy).toHaveBeenCalled();
	});
});

describe('hourly activity discovery', () => {
	const controller = { cron: '0 * * * *' } as ScheduledController;
	const ctx = {
		waitUntil: vi.fn(),
		passThroughOnException: vi.fn()
	} as unknown as ExecutionContext;

	it('runs discovery after the prompt is posted, in that order', async () => {
		await scheduled(controller, createMockBindings(), ctx);

		expect(mocks.createPrompt).toHaveBeenCalledTimes(1);
		expect(mocks.postPrompt).toHaveBeenCalledTimes(1);
		expect(mocks.runActivityDiscovery).toHaveBeenCalledTimes(1);

		const [createOrder] = mocks.createPrompt.mock.invocationCallOrder;
		const [postOrder] = mocks.postPrompt.mock.invocationCallOrder;
		const [discoverOrder] = mocks.runActivityDiscovery.mock.invocationCallOrder;
		expect(createOrder).toBeLessThan(postOrder);
		expect(postOrder).toBeLessThan(discoverOrder);
	});

	it('swallows a discovery failure so the hourly prompt is never lost', async () => {
		mocks.runActivityDiscovery.mockRejectedValueOnce(new Error('wikidata down'));

		await expect(scheduled(controller, createMockBindings(), ctx)).resolves.toBeUndefined();
		expect(mocks.postPrompt).toHaveBeenCalledTimes(1);
	});

	it('still propagates a prompt failure and never reaches discovery', async () => {
		mocks.createPrompt.mockRejectedValueOnce(new Error('ai down'));

		await expect(scheduled(controller, createMockBindings(), ctx)).rejects.toThrow('ai down');
		expect(mocks.runActivityDiscovery).not.toHaveBeenCalled();
	});

	it('does not run discovery on the other cron schedules', async () => {
		for (const cron of ['0 */4 * * *', '0 0 */4 * *', '0 2 * * *']) {
			vi.clearAllMocks();
			mocks.retrieveLeaderboard.mockResolvedValue([]);
			mocks.findArticle.mockResolvedValue([[], []]);
			mocks.retrieveEvents.mockResolvedValue([]);

			await scheduled({ cron } as ScheduledController, createMockBindings(), ctx);

			expect(mocks.runActivityDiscovery).not.toHaveBeenCalled();
		}
	});
});
