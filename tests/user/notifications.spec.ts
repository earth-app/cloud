import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveNotifier, sendUserNotification } from '../../src/user/notifications';
import { createMockBindings } from '../helpers/mock-bindings';

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
		},
		transaction: async <T>(
			handler: (txn: {
				get: <U = unknown>(key: string) => Promise<U | undefined>;
				delete: (key: string) => Promise<void>;
			}) => Promise<T>
		) => {
			return handler({
				get: async <U = unknown>(key: string) => store.get(key) as U | undefined,
				delete: async (key: string) => {
					store.delete(key);
				}
			});
		}
	};

	return { storage } as unknown as DurableObjectState;
}

describe('sendUserNotification', () => {
	it('posts notifications to mantle endpoint with bearer auth', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
		const bindings = createMockBindings({ MANTLE_URL: 'https://mantle.test' });

		await sendUserNotification(bindings, '123', 'Title', 'Description', '/x', 'success', 'cloud');

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [url, init] = fetchSpy.mock.calls[0];
		expect(url).toBe('https://mantle.test/v2/users/123/notifications');
		expect((init as RequestInit).method).toBe('POST');
	});
});

describe('LiveNotifier', () => {
	it('rejects invalid json for ticket issuance', async () => {
		const notifier = new LiveNotifier(createDurableState());
		const res = await notifier.fetch(
			new Request('https://do/ticket', { method: 'POST', body: 'nope' })
		);
		expect(res.status).toBe(400);
	});

	it('issues a ticket for valid ticket request payload', async () => {
		const notifier = new LiveNotifier(createDurableState());
		const res = await notifier.fetch(
			new Request('https://do/ticket', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ userId: '42', ttlSeconds: 600 })
			})
		);

		expect(res.status).toBe(200);
		const body = await res.json<{ ticket: string; expiresAt: number }>();
		expect(body.ticket).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
		);
		expect(body.expiresAt).toBeGreaterThan(Date.now());
	});

	it('rejects websocket upgrade when ticket is missing or invalid', async () => {
		const notifier = new LiveNotifier(createDurableState());
		const missing = await notifier.fetch(
			new Request('https://do/connect?userId=42', {
				method: 'GET',
				headers: { Upgrade: 'websocket' }
			})
		);
		expect(missing.status).toBe(401);

		const invalid = await notifier.fetch(
			new Request('https://do/connect?ticket=abc&userId=42', {
				method: 'GET',
				headers: { Upgrade: 'websocket' }
			})
		);
		expect(invalid.status).toBe(401);
	});

	it('accepts backend push payloads', async () => {
		const notifier = new LiveNotifier(createDurableState());
		const res = await notifier.fetch(
			new Request('https://do/push', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ message: 'hello' })
			})
		);

		expect(res.status).toBe(200);
		expect(await res.text()).toBe('ok');
	});
});
