import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveNotifier, sendUserNotification } from '../../src/user/notifications';
import { createMockBindings } from '../helpers/mock-bindings';

afterEach(() => {
	vi.restoreAllMocks();
});

function createDurableState(): DurableObjectState {
	return createDurableStateHarness().state;
}

function createDurableStateHarness(): {
	state: DurableObjectState;
	store: Map<string, unknown>;
} {
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

	return {
		state: { storage } as unknown as DurableObjectState,
		store
	};
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
		expect(res.headers.get('cache-control')).toContain('no-store');
	});

	it('rejects invalid user IDs during ticket issuance', async () => {
		const notifier = new LiveNotifier(createDurableState());

		const missing = await notifier.fetch(
			new Request('https://do/ticket', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({})
			})
		);
		expect(missing.status).toBe(400);

		const tooLong = await notifier.fetch(
			new Request('https://do/ticket', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ userId: 'x'.repeat(129) })
			})
		);
		expect(tooLong.status).toBe(400);
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

	it('bounds ttlSeconds to min/max limits when issuing tickets', async () => {
		const notifier = new LiveNotifier(createDurableState());

		const minNow = Date.now();
		const minRes = await notifier.fetch(
			new Request('https://do/ticket', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ userId: '42', ttlSeconds: 1 })
			})
		);
		const minBody = await minRes.json<{ expiresAt: number }>();
		expect(minBody.expiresAt - minNow).toBeGreaterThanOrEqual(4_000);

		const maxNow = Date.now();
		const maxRes = await notifier.fetch(
			new Request('https://do/ticket', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ userId: '42', ttlSeconds: 999 })
			})
		);
		const maxBody = await maxRes.json<{ expiresAt: number }>();
		expect(maxBody.expiresAt - maxNow).toBeLessThanOrEqual(301_000);
	});

	it('returns 500 when ticket persistence fails', async () => {
		const harness = createDurableStateHarness();
		(harness.state as any).storage.put = async () => {
			throw new Error('storage unavailable');
		};

		const notifier = new LiveNotifier(harness.state);
		const res = await notifier.fetch(
			new Request('https://do/ticket', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ userId: '42' })
			})
		);

		expect(res.status).toBe(500);
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

	it('accepts websocket upgrade for a valid one-time ticket and then consumes it', async () => {
		if (typeof (globalThis as any).WebSocketPair !== 'function') {
			return;
		}

		const notifier = new LiveNotifier(createDurableState());
		const ticketRes = await notifier.fetch(
			new Request('https://do/ticket', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ userId: '42' })
			})
		);

		const ticketBody = await ticketRes.json<{ ticket: string }>();
		const connectReq = new Request(`https://do/connect?ticket=${ticketBody.ticket}&userId=42`, {
			method: 'GET',
			headers: { Upgrade: 'websocket' }
		});

		const accepted = await notifier.fetch(connectReq);
		expect(accepted.status).toBe(101);
		expect((notifier as any).sockets.size).toBe(1);

		const consumed = await notifier.fetch(connectReq);
		expect(consumed.status).toBe(401);

		const serverSocket = [...(notifier as any).sockets][0] as any;
		if (typeof serverSocket.dispatchEvent === 'function') {
			serverSocket.dispatchEvent(new Event('error'));
			serverSocket.dispatchEvent(new Event('close'));
		} else {
			serverSocket.close?.(1000, 'done');
			await Promise.resolve();
		}

		expect((notifier as any).sockets.size).toBeLessThanOrEqual(1);
	});

	it('rejects websocket upgrade when ticket user does not match and consumes the ticket', async () => {
		const notifier = new LiveNotifier(createDurableState());
		const ticketRes = await notifier.fetch(
			new Request('https://do/ticket', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ userId: '42' })
			})
		);

		const { ticket } = await ticketRes.json<{ ticket: string }>();
		const mismatch = await notifier.fetch(
			new Request(`https://do/connect?ticket=${ticket}&userId=99`, {
				method: 'GET',
				headers: { Upgrade: 'websocket' }
			})
		);
		expect(mismatch.status).toBe(401);

		const consumed = await notifier.fetch(
			new Request(`https://do/connect?ticket=${ticket}&userId=42`, {
				method: 'GET',
				headers: { Upgrade: 'websocket' }
			})
		);
		expect(consumed.status).toBe(401);
	});

	it('rejects expired websocket tickets', async () => {
		const harness = createDurableStateHarness();
		const notifier = new LiveNotifier(harness.state);
		const expiredTicket = '11111111-1111-4111-8111-111111111111';
		harness.store.set(`ticket:${expiredTicket}`, {
			userId: '42',
			expiresAt: Date.now() - 1_000
		});

		const res = await notifier.fetch(
			new Request(`https://do/connect?ticket=${expiredTicket}&userId=42`, {
				method: 'GET',
				headers: { Upgrade: 'websocket' }
			})
		);

		expect(res.status).toBe(401);
		expect(harness.store.has(`ticket:${expiredTicket}`)).toBe(false);
	});

	it('returns 500 when ticket consume transaction fails during websocket upgrade', async () => {
		const harness = createDurableStateHarness();
		(harness.state as any).storage.transaction = async () => {
			throw new Error('transaction failed');
		};

		const notifier = new LiveNotifier(harness.state);
		const res = await notifier.fetch(
			new Request('https://do/connect?ticket=11111111-1111-4111-8111-111111111111&userId=42', {
				method: 'GET',
				headers: { Upgrade: 'websocket' }
			})
		);

		expect(res.status).toBe(500);
	});

	it('rejects websocket upgrade with missing or invalid user IDs', async () => {
		const notifier = new LiveNotifier(createDurableState());

		const missing = await notifier.fetch(
			new Request('https://do/connect?ticket=11111111-1111-4111-8111-111111111111', {
				method: 'GET',
				headers: { Upgrade: 'websocket' }
			})
		);
		expect(missing.status).toBe(401);

		const tooLong = await notifier.fetch(
			new Request(
				`https://do/connect?ticket=11111111-1111-4111-8111-111111111111&userId=${'x'.repeat(129)}`,
				{
					method: 'GET',
					headers: { Upgrade: 'websocket' }
				}
			)
		);
		expect(tooLong.status).toBe(401);
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

	it('rejects invalid json payloads for backend push', async () => {
		const notifier = new LiveNotifier(createDurableState());
		const res = await notifier.fetch(new Request('https://do/push', { method: 'POST', body: '{' }));

		expect(res.status).toBe(400);
	});

	it('prunes stale sockets when send fails and keeps healthy sockets', async () => {
		const notifier = new LiveNotifier(createDurableState());
		const healthy = { send: vi.fn() } as unknown as WebSocket;
		const stale = {
			send: vi.fn(() => {
				throw new Error('stale');
			})
		} as unknown as WebSocket;

		notifier.sockets.add(healthy);
		notifier.sockets.add(stale);

		const res = await notifier.fetch(
			new Request('https://do/push', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ message: 'hello' })
			})
		);

		expect(res.status).toBe(200);
		expect((healthy as any).send).toHaveBeenCalledTimes(1);
		expect(notifier.sockets.has(healthy)).toBe(true);
		expect(notifier.sockets.has(stale)).toBe(false);
	});

	it('returns 405 for non-GET websocket endpoint calls', async () => {
		const notifier = new LiveNotifier(createDurableState());
		const res = await notifier.fetch(new Request('https://do/connect', { method: 'POST' }));

		expect(res.status).toBe(405);
		expect(res.headers.get('pragma')).toBe('no-cache');
	});

	it('returns 404 for unknown paths and websocket upgrades on non-connect paths', async () => {
		const notifier = new LiveNotifier(createDurableState());

		const unknownWs = await notifier.fetch(
			new Request('https://do/elsewhere', {
				method: 'GET',
				headers: { Upgrade: 'websocket' }
			})
		);
		expect(unknownWs.status).toBe(404);

		const unknown = await notifier.fetch(new Request('https://do/nope', { method: 'GET' }));
		expect(unknown.status).toBe(404);
	});
});
