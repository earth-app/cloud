import { vi } from 'vitest';
import app from '../../src/app';
import { createMockBindings } from './mock-bindings';
import type { Bindings } from '../../src/util/types';

export function authedRequest(path: string, init: RequestInit = {}, authenticated = true): Request {
	const headers = new Headers(init.headers);
	if (authenticated) {
		headers.set('Authorization', 'Bearer test-admin-key');
	}
	if (init.body && !headers.has('Content-Type')) {
		headers.set('Content-Type', 'application/json');
	}
	return new Request(`https://cloud.test${path}`, { ...init, headers });
}

// drives app.fetch with a real execution ctx and settles any waitUntil work before returning.
// pass a shared `bindings` across calls when a test needs state to persist between requests
export async function callApp(
	path: string,
	init: RequestInit = {},
	authenticated = true,
	bindings: Bindings = createMockBindings()
): Promise<{ response: Response; bindings: Bindings }> {
	const pending: Promise<unknown>[] = [];
	const ctx = {
		waitUntil: vi.fn((p: Promise<unknown>) => {
			pending.push(Promise.resolve(p).catch(() => {}));
		})
	};
	const response = await app.fetch(authedRequest(path, init, authenticated), bindings, ctx as any);
	let processed = 0;
	while (processed < pending.length) {
		const current = pending.slice(processed);
		processed = pending.length;
		await Promise.allSettled(current);
	}
	return { response, bindings };
}
