import { afterEach, describe, expect, it, vi } from 'vitest';
import { UserTimer, getReadTime } from '../../src/user/timer';
import { createMockBindings } from '../helpers/mock-bindings';
import { MockKVNamespace } from '../helpers/mock-kv';
import { quests } from '../../src/user/quests';
import {
	getCompletedQuestProgress,
	getQuestHistory,
	startQuest
} from '../../src/user/quests/tracking';

afterEach(() => {
	vi.restoreAllMocks();
});

function createDurableState(): DurableObjectState {
	const store = new Map<string, unknown>();
	const storage = {
		put: async (key: string, value: unknown) => {
			store.set(key, value);
		},
		get: async <T = unknown>(key: string) => store.get(key) as T | undefined,
		delete: async (key: string) => {
			store.delete(key);
		}
	};
	return { storage } as unknown as DurableObjectState;
}

describe('UserTimer', () => {
	it('starts a timer and returns 204', async () => {
		const timer = new UserTimer(createDurableState(), createMockBindings());
		const res = await timer.fetch(
			new Request('https://do/timer', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'start', userId: '10', field: 'articles_read_time:1' })
			})
		);

		expect(res).toBeDefined();
		if (!res) throw new Error('Expected response');
		expect(res.status).toBe(204);
	});

	it('prevents duplicate start while running', async () => {
		const timer = new UserTimer(createDurableState(), createMockBindings());
		const request = new Request('https://do/timer', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'start', userId: '10', field: 'articles_read_time:1' })
		});

		await timer.fetch(request.clone() as any);
		const res = await timer.fetch(request.clone() as any);
		expect(res).toBeDefined();
		if (!res) throw new Error('Expected response');
		expect(res.status).toBe(409);
		expect(await res.text()).toBe('Already running');
	});

	it('prevents duplicate start after durable object restart', async () => {
		const state = createDurableState();
		const firstInstance = new UserTimer(state, createMockBindings());
		const startRequest = new Request('https://do/timer', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'start', userId: '10', field: 'articles_read_time:1' })
		});

		await firstInstance.fetch(startRequest.clone() as any);

		const secondInstance = new UserTimer(state, createMockBindings());
		const res = await secondInstance.fetch(startRequest.clone() as any);
		expect(res.status).toBe(409);
		expect(await res.text()).toBe('Already running');
	});

	it('returns 409 when stopping a non-running timer', async () => {
		const timer = new UserTimer(createDurableState(), createMockBindings());
		const res = await timer.fetch(
			new Request('https://do/timer', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'stop', userId: '10', field: 'articles_read_time:1' })
			})
		);

		expect(res).toBeDefined();
		if (!res) throw new Error('Expected response');
		expect(res.status).toBe(409);
		expect(await res.text()).toBe('Not running');
	});

	it('stops a running timer and applies badge tracker updates', async () => {
		const kv = new MockKVNamespace();
		const bindings = createMockBindings({ KV: kv as any });
		const kvPutSpy = vi.spyOn(kv, 'put');
		const timer = new UserTimer(createDurableState(), bindings);

		let now = 1_000;
		vi.spyOn(Date, 'now').mockImplementation(() => now);

		await timer.fetch(
			new Request('https://do/timer', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					action: 'start',
					userId: '42',
					field: 'articles_read_time:article-1',
					metadata: {
						article: {
							id: 'article-1',
							author_id: 'author-1',
							title: 'Ocean News'
						}
					}
				})
			})
		);

		now = 70_000;
		const res = await timer.fetch(
			new Request('https://do/timer', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					action: 'stop',
					userId: '42',
					field: 'articles_read_time:article-1'
				})
			})
		);

		expect(res).toBeDefined();
		if (!res) throw new Error('Expected response');
		expect(res.status).toBe(200);
		const body = await res.json<{ durationMs: number }>();
		expect(body.durationMs).toBe(69_000);

		const readTracker = await kv.get('user:badge_tracker:42:articles_read', 'json');
		const timeTracker = await kv.get('user:badge_tracker:42:articles_read_time', 'json');
		expect(Array.isArray(readTracker)).toBe(true);
		expect(Array.isArray(timeTracker)).toBe(true);

		const analytics = await kv.get<{
			article_read_time?: { total: number };
			articles_clicked?: { total: number };
		}>('content_analytics:article-1', 'json');
		expect(analytics?.article_read_time?.total).toBeGreaterThan(0);
		expect(analytics?.articles_clicked?.total).toBe(1);

		const contentAnalyticsWrites = kvPutSpy.mock.calls.filter(
			([key]) => key === 'content_analytics:article-1'
		);
		expect(contentAnalyticsWrites).toHaveLength(1);
	});

	it('allows starting again after a successful stop', async () => {
		const timer = new UserTimer(
			createDurableState(),
			createMockBindings({ KV: new MockKVNamespace() as any })
		);

		let now = 5_000;
		vi.spyOn(Date, 'now').mockImplementation(() => now);

		const startRequest = new Request('https://do/timer', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'start',
				userId: '42',
				field: 'articles_read_time:article-2'
			})
		});

		const firstStart = await timer.fetch(startRequest.clone() as any);
		expect(firstStart.status).toBe(204);

		now = 20_000;
		const stopResponse = await timer.fetch(
			new Request('https://do/timer', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					action: 'stop',
					userId: '42',
					field: 'articles_read_time:article-2'
				})
			})
		);
		expect(stopResponse.status).toBe(200);

		const secondStart = await timer.fetch(startRequest.clone() as any);
		expect(secondStart.status).toBe(204);
	});

	it('stops successfully without metadata by falling back to field id', async () => {
		const kv = new MockKVNamespace();
		const bindings = createMockBindings({ KV: kv as any });
		const timer = new UserTimer(createDurableState(), bindings);

		let now = 1_000;
		vi.spyOn(Date, 'now').mockImplementation(() => now);

		await timer.fetch(
			new Request('https://do/timer', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					action: 'start',
					userId: '50',
					field: 'articles_read_time:article-fallback'
				})
			})
		);

		now = 20_000;
		const stopResponse = await timer.fetch(
			new Request('https://do/timer', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					action: 'stop',
					userId: '50',
					field: 'articles_read_time:article-fallback'
				})
			})
		);

		expect(stopResponse.status).toBe(200);
		const analytics = await kv.get<{ articles_clicked?: { total: number } }>(
			'content_analytics:article-fallback',
			'json'
		);
		expect(analytics?.articles_clicked?.total).toBe(1);
	});

	it('preserves metadata on activity_read_time trackers and completes matching read-time quests', async () => {
		const kv = new MockKVNamespace();
		const bindings = createMockBindings({ KV: kv as any });
		const timer = new UserTimer(createDurableState(), bindings);

		const questId = 'timer_read_time_regression';
		const quest = {
			id: questId,
			title: 'Timer Read Time Regression',
			description: 'Validates auto-completion for read-time steps.',
			icon: 'mdi:timer-outline',
			rarity: 'normal',
			steps: [
				{
					type: 'article_read_time',
					description: 'Read for at least 5 seconds.',
					parameters: ['SPORT', 5]
				}
			],
			reward: 10
		} as any;

		quests.push(quest);
		try {
			await startQuest('42', questId, bindings);

			let now = 1_000;
			vi.spyOn(Date, 'now').mockImplementation(() => now);

			await timer.fetch(
				new Request('https://do/timer', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						action: 'start',
						userId: '42',
						field: 'articles_read_time:article-quest',
						metadata: {
							article: {
								id: 'article-quest',
								author_id: 'author-1',
								title: 'Quest Article'
							}
						}
					})
				})
			);

			now = 7_500;
			const stopResponse = await timer.fetch(
				new Request('https://do/timer', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						action: 'stop',
						userId: '42',
						field: 'articles_read_time:article-quest'
					})
				})
			);

			expect(stopResponse.status).toBe(200);
			const tracker = await kv.get<{ metadata?: Record<string, unknown>; value: number }[]>(
				'user:badge_tracker:42:articles_read_time',
				'json'
			);
			expect(tracker).toHaveLength(1);
			expect(tracker?.[0]?.metadata).toBeDefined();

			const totalReadTime = await getReadTime('42', 'articles_read_time', kv as any);
			expect(totalReadTime).toBeGreaterThanOrEqual(5);

			const questHistory = await getQuestHistory('42', bindings);
			expect(questHistory).toContain(questId);

			const completedQuest = await getCompletedQuestProgress('42', questId, bindings);
			expect(completedQuest).not.toBeNull();
			expect(completedQuest?.questId).toBe(questId);
		} finally {
			quests.splice(quests.indexOf(quest), 1);
		}
	});
});
