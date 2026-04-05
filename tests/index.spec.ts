import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src';

const IncomingRequest = Request;

describe('/', () => {
	it('GET responds with Woosh!', async () => {
		const request = new IncomingRequest('https://cloud.earth-app.com/');
		const ctx = createExecutionContext();

		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('Woosh!');
	});
});
