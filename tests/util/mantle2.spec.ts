import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchReportableContentText, requestContentRemoval } from '../../src/util/mantle2';
import { createMockBindings } from '../helpers/mock-bindings';

afterEach(() => {
	vi.restoreAllMocks();
});

describe('fetchReportableContentText', () => {
	const cases: Array<{ type: string; id: string; parentId?: string; path: string }> = [
		{ type: 'prompt', id: 'p1', path: '/v2/prompts/p1' },
		{ type: 'prompt_response', id: 'r1', parentId: 'p1', path: '/v2/prompts/p1/responses/r1' },
		{ type: 'article', id: 'a1', path: '/v2/articles/a1' },
		{ type: 'event', id: 'e1', path: '/v2/events/e1' },
		{ type: 'user', id: 'u1', path: '/v2/users/u1' }
	];

	for (const { type, id, parentId, path } of cases) {
		it(`fetches and concatenates text fields for ${type}`, async () => {
			const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
				new Response(JSON.stringify({ title: 'Title', description: 'Desc', ignored: 5 }), {
					status: 200
				})
			);

			const text = await fetchReportableContentText(createMockBindings(), type, id, parentId);
			expect(text).toBe('Title\nDesc');

			const calledUrl = String(fetchSpy.mock.calls[0][0]);
			expect(calledUrl).toContain(path);
		});
	}

	it('passes the admin bearer token', async () => {
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(new Response(JSON.stringify({ content: 'hi' }), { status: 200 }));

		await fetchReportableContentText(createMockBindings(), 'article', 'a1');
		const init = fetchSpy.mock.calls[0][1] as RequestInit;
		expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-admin-key');
	});

	it('returns empty string for an unknown content type without fetching', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch');
		const text = await fetchReportableContentText(createMockBindings(), 'comment', 'x');
		expect(text).toBe('');
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('returns empty string on a non-ok response', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('nope', { status: 404 }));
		expect(await fetchReportableContentText(createMockBindings(), 'article', 'a1')).toBe('');
	});

	it('returns empty string when fetch throws', async () => {
		vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('network'));
		expect(await fetchReportableContentText(createMockBindings(), 'article', 'a1')).toBe('');
	});

	it('caps concatenated text at 4000 characters', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(JSON.stringify({ content: 'x'.repeat(5000) }), { status: 200 })
		);
		const text = await fetchReportableContentText(createMockBindings(), 'article', 'a1');
		expect(text).toHaveLength(4000);
	});
});

describe('requestContentRemoval', () => {
	it('PATCHes the report with a delete_content action and returns true on success', async () => {
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(new Response(null, { status: 200 }));

		const ok = await requestContentRemoval(createMockBindings(), 'rep-1');
		expect(ok).toBe(true);

		const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(String(url)).toContain('/v2/reports/rep-1');
		expect(init.method).toBe('PATCH');
		expect(JSON.parse(String(init.body))).toMatchObject({ action: 'delete_content' });
	});

	it('returns false on a non-ok response', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('err', { status: 500 }));
		expect(await requestContentRemoval(createMockBindings(), 'rep-1')).toBe(false);
	});

	it('returns false when fetch throws', async () => {
		vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('network'));
		expect(await requestContentRemoval(createMockBindings(), 'rep-1')).toBe(false);
	});
});
