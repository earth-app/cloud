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
};

function createMocks() {
	return {
		retrieveLeaderboard: vi.fn(),
		createPrompt: vi.fn(),
		postPrompt: vi.fn(),
		findArticle: vi.fn(),
		createArticle: vi.fn(),
		createArticleQuiz: vi.fn(),
		postArticle: vi.fn(),
		retrieveEvents: vi.fn(),
		createEvent: vi.fn(),
		postEvent: vi.fn()
	};
}

vi.mock('../src/user/journies', () => ({
	TOP_LEADERBOARD_COUNT: 250,
	retrieveLeaderboard: (mocks ??= createMocks()).retrieveLeaderboard
}));

vi.mock('../src/content/boat', () => ({
	createPrompt: (mocks ??= createMocks()).createPrompt,
	postPrompt: (mocks ??= createMocks()).postPrompt,
	findArticle: (mocks ??= createMocks()).findArticle,
	createArticle: (mocks ??= createMocks()).createArticle,
	createArticleQuiz: (mocks ??= createMocks()).createArticleQuiz,
	postArticle: (mocks ??= createMocks()).postArticle,
	retrieveEvents: (mocks ??= createMocks()).retrieveEvents,
	createEvent: (mocks ??= createMocks()).createEvent,
	postEvent: (mocks ??= createMocks()).postEvent
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

	it('creates and posts a prompt on prompt cron', async () => {
		await scheduled({ cron: '*/12 * * * *' } as ScheduledController, createMockBindings(), {
			waitUntil: () => {}
		} as any);

		expect(mocks.createPrompt).toHaveBeenCalledTimes(1);
		expect(mocks.postPrompt).toHaveBeenCalledWith('Prompt?', expect.anything());
	});

	it('creates and posts generated articles on hourly cron', async () => {
		await scheduled({ cron: '0 * * * *' } as ScheduledController, createMockBindings(), {
			waitUntil: () => {}
		} as any);

		expect(mocks.findArticle).toHaveBeenCalledTimes(1);
		expect(mocks.createArticle).toHaveBeenCalledTimes(2);
		expect(mocks.createArticleQuiz).toHaveBeenCalledTimes(2);
		expect(mocks.postArticle).toHaveBeenCalledTimes(2);
	});

	it('revokes badges invalidated by duplicate tracker cleanup on hourly cron', async () => {
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

		await scheduled({ cron: '0 * * * *' } as ScheduledController, createMockBindings({ KV: kv }), {
			waitUntil: () => {}
		} as any);

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

		await scheduled({ cron: '0 0 */2 * *' } as ScheduledController, createMockBindings(), {
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

		await scheduled({ cron: '0 0 */2 * *' } as ScheduledController, createMockBindings(), {
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

		await scheduled({ cron: '0 0 */2 * *' } as ScheduledController, createMockBindings(), {
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

	it('logs when no cron branch matches', async () => {
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

		await scheduled({ cron: '*/5 * * * *' } as ScheduledController, createMockBindings(), {
			waitUntil: () => {}
		} as any);

		expect(spy).toHaveBeenCalled();
	});
});
