import { afterEach, describe, expect, it, vi } from 'vitest';
import ws from '../src/ws';
import { createMockBindings } from './helpers/mock-bindings';

afterEach(() => {
	vi.restoreAllMocks();
});

function createWsBindings(notifierFetch: ReturnType<typeof vi.fn>) {
	const notifier = {
		idFromName: vi.fn((name: string) => name),
		get: vi.fn(() => ({ fetch: notifierFetch }))
	} as unknown as DurableObjectNamespace;

	return createMockBindings({
		NOTIFIER: notifier,
		MANTLE_URL: 'https://mantle.test'
	});
}

function request(path: string, init: RequestInit = {}) {
	return new Request(`https://cloud.test${path}`, init);
}

describe('ws route registration', () => {
	it('registers notify, ticket, and notifications websocket routes', () => {
		const routes = ((ws as any).routes || []).map((r: any) => `${r.method} ${r.path}`);
		expect(routes).toEqual(
			expect.arrayContaining([
				'POST /notify',
				'GET /users/:id/ticket',
				'GET /users/:id/notifications'
			])
		);
	});
});

describe('POST /notify', () => {
	it('requires admin bearer auth', async () => {
		const bindings = createWsBindings(vi.fn(async () => new Response('ok')));
		const res = await ws.fetch(
			request('/notify', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ channel: 'users:1', data: { hello: true } })
			}),
			bindings,
			{ waitUntil: () => {} } as any
		);
		expect(res.status).toBe(401);
	});

	it('rejects invalid channel payload', async () => {
		const bindings = createWsBindings(vi.fn(async () => new Response('ok')));
		const res = await ws.fetch(
			request('/notify', {
				method: 'POST',
				headers: {
					Authorization: 'Bearer test-admin-key',
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({})
			}),
			bindings,
			{ waitUntil: () => {} } as any
		);
		expect(res.status).toBe(400);
	});

	it('forwards valid notifications to durable object', async () => {
		const notifierFetch = vi.fn(async () => new Response('ok', { status: 200 }));
		const bindings = createWsBindings(notifierFetch);
		const res = await ws.fetch(
			request('/notify', {
				method: 'POST',
				headers: {
					Authorization: 'Bearer test-admin-key',
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({ channel: 'users:1', data: { hello: true } })
			}),
			bindings,
			{ waitUntil: () => {} } as any
		);

		expect(res.status).toBe(200);
		expect(notifierFetch).toHaveBeenCalled();
	});
});

describe('GET /users/:id/ticket', () => {
	it('rejects when session token is missing', async () => {
		const bindings = createWsBindings(vi.fn(async () => new Response('ok')));
		const res = await ws.fetch(request('/users/123/ticket', { method: 'GET' }), bindings, {
			waitUntil: () => {}
		} as any);
		expect(res.status).toBe(401);
	});

	it('rejects when mantle session validation fails', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('no', { status: 401 }));
		const bindings = createWsBindings(vi.fn(async () => new Response('ok')));
		const res = await ws.fetch(
			request('/users/123/ticket', {
				method: 'GET',
				headers: { Authorization: 'Bearer session-token' }
			}),
			bindings,
			{ waitUntil: () => {} } as any
		);
		expect(res.status).toBe(401);
	});

	it('rejects when validated session user does not match target user', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(JSON.stringify({ id: '999', account: { account_type: 'USER' } }), {
				status: 200
			})
		);
		const bindings = createWsBindings(vi.fn(async () => new Response('ok')));
		const res = await ws.fetch(
			request('/users/123/ticket', {
				method: 'GET',
				headers: { Authorization: 'Bearer session-token' }
			}),
			bindings,
			{ waitUntil: () => {} } as any
		);
		expect(res.status).toBe(403);
	});

	it('issues a ticket after successful session validation', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(JSON.stringify({ id: '123', account: { account_type: 'USER' } }), {
				status: 200
			})
		);
		const notifierFetch = vi.fn(async () =>
			Response.json({
				ticket: '123e4567-e89b-42d3-a456-426614174000',
				expiresAt: Date.now() + 60000
			})
		);
		const bindings = createWsBindings(notifierFetch);
		const res = await ws.fetch(
			request('/users/123/ticket', {
				method: 'GET',
				headers: { Authorization: 'Bearer session-token' }
			}),
			bindings,
			{ waitUntil: () => {} } as any
		);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ticket: '123e4567-e89b-42d3-a456-426614174000' });
	});
});

describe('GET /users/:id/notifications', () => {
	it('rejects when ticket is missing', async () => {
		const bindings = createWsBindings(vi.fn(async () => new Response('ok')));
		const res = await ws.fetch(
			request('/users/123/notifications', {
				method: 'GET',
				headers: { Upgrade: 'websocket' }
			}),
			bindings,
			{ waitUntil: () => {} } as any
		);
		expect(res.status).toBe(401);
	});

	it('rejects malformed ticket values', async () => {
		const bindings = createWsBindings(vi.fn(async () => new Response('ok')));
		const res = await ws.fetch(
			request('/users/123/notifications?ticket=abc', {
				method: 'GET',
				headers: { Upgrade: 'websocket' }
			}),
			bindings,
			{ waitUntil: () => {} } as any
		);
		expect(res.status).toBe(401);
	});

	it('requires websocket upgrade header', async () => {
		const bindings = createWsBindings(vi.fn(async () => new Response('ok')));
		const res = await ws.fetch(
			request('/users/123/notifications?ticket=123e4567-e89b-42d3-a456-426614174000', {
				method: 'GET'
			}),
			bindings,
			{ waitUntil: () => {} } as any
		);
		expect(res.status).toBe(426);
	});

	it('returns 502 when notifier forwarding throws', async () => {
		const bindings = createWsBindings(
			vi.fn(async () => {
				throw new Error('do down');
			})
		);
		const res = await ws.fetch(
			request('/users/123/notifications?ticket=123e4567-e89b-42d3-a456-426614174000', {
				method: 'GET',
				headers: { Upgrade: 'websocket' }
			}),
			bindings,
			{ waitUntil: () => {} } as any
		);
		expect(res.status).toBe(502);
	});
});
