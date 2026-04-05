import { afterEach, describe, expect, it, vi } from 'vitest';
import { UserTimer } from '../../src/user/timer';
import { createMockBindings } from '../helpers/mock-bindings';
import { MockKVNamespace } from '../helpers/mock-kv';

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
					field: 'articles_read_time:article-1'
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
	});
});
