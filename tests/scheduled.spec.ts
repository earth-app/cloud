import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
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
}));

vi.mock('../src/user/journies', () => ({
	TOP_LEADERBOARD_COUNT: 250,
	retrieveLeaderboard: mocks.retrieveLeaderboard
}));

vi.mock('../src/content/boat', () => ({
	createPrompt: mocks.createPrompt,
	postPrompt: mocks.postPrompt,
	findArticle: mocks.findArticle,
	createArticle: mocks.createArticle,
	createArticleQuiz: mocks.createArticleQuiz,
	postArticle: mocks.postArticle,
	retrieveEvents: mocks.retrieveEvents,
	createEvent: mocks.createEvent,
	postEvent: mocks.postEvent
}));

import scheduled from '../src/scheduled';
import { createMockBindings } from './helpers/mock-bindings';

beforeEach(() => {
	vi.clearAllMocks();
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
	it('caches all leaderboard journey types on hourly cron', async () => {
		await scheduled({ cron: '0 * * * *' } as ScheduledController, createMockBindings(), {
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

	it('creates and posts generated articles on article cron', async () => {
		await scheduled({ cron: '*/24 * * * *' } as ScheduledController, createMockBindings(), {
			waitUntil: () => {}
		} as any);

		expect(mocks.findArticle).toHaveBeenCalledTimes(1);
		expect(mocks.createArticle).toHaveBeenCalledTimes(2);
		expect(mocks.createArticleQuiz).toHaveBeenCalledTimes(2);
		expect(mocks.postArticle).toHaveBeenCalledTimes(2);
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
