import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	fetchReportableContentText,
	getDeniedStagedActivityIds,
	postStagedActivity,
	retrieveActivityIds,
	requestContentRemoval
} from '../../src/util/mantle2';
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

describe('postStagedActivity', () => {
	const activity = {
		id: 'bouldering',
		name: 'Bouldering',
		description: 'A generated description of the proposed activity.',
		aliases: ['climbing'],
		types: ['SPORT'],
		fields: { icon: 'mdi:climbing' }
	} as unknown as Parameters<typeof postStagedActivity>[1];

	it('posts to the staging endpoint with the admin bearer and default source', async () => {
		const bindings = createMockBindings();
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(JSON.stringify({ id: 12, fails_open: false, submitter_kind: 'cloud' }), {
				status: 201
			})
		);

		const result = await postStagedActivity(bindings, activity);

		const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(`${bindings.MANTLE_URL}/v2/activities/staged`);
		expect(init.method).toBe('POST');
		expect((init.headers as Record<string, string>).Authorization).toBe(
			`Bearer ${bindings.ADMIN_API_KEY}`
		);
		expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');

		const body = JSON.parse(init.body as string);
		expect(body.source).toBe('cloud_discovery');
		expect(body.types).toEqual(['SPORT']);
		expect(body.id).toBe('bouldering');
		expect(result?.id).toBe(12);
	});

	it('resolves null on a 409 so a wiped ledger cannot become a throw loop', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('conflict', { status: 409 }));

		await expect(postStagedActivity(createMockBindings(), activity)).resolves.toBeNull();
	});

	it('throws with the status and body on a server error', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('boom', { status: 500 }));

		await expect(postStagedActivity(createMockBindings(), activity)).rejects.toThrow(/500.*boom/);
	});

	it('throws when the response carries no id', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{}', { status: 201 }));

		await expect(postStagedActivity(createMockBindings(), activity)).rejects.toThrow(
			'no ID returned'
		);
	});

	it('logs loudly when a submission comes back as the wrong submitter kind', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(JSON.stringify({ id: 4, fails_open: false, submitter_kind: 'organizer' }), {
				status: 201
			})
		);

		await postStagedActivity(createMockBindings(), activity);

		expect(error).toHaveBeenCalledWith(
			expect.stringContaining('wrong submitter kind'),
			expect.objectContaining({ submitter_kind: 'organizer' })
		);
	});

	// fails_open is false for every row now, so it must not be read as a credential signal
	it('stays quiet on a fail-closed cloud row', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(JSON.stringify({ id: 5, fails_open: false, submitter_kind: 'cloud' }), {
				status: 201
			})
		);

		await postStagedActivity(createMockBindings(), activity);

		expect(error).not.toHaveBeenCalled();
	});
});

describe('getDeniedStagedActivityIds', () => {
	it('returns the denied activity ids', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					items: [{ activity: { id: 'amateurism' } }, { activity: { id: 'fandom' } }]
				}),
				{ status: 200 }
			)
		);

		const ids = await getDeniedStagedActivityIds(createMockBindings());

		// expired_denied is the common case: mantle2's cron denies unreviewed rows, so
		// asking for state=denied alone would let every auto-denial be re-proposed forever
		const url = String(fetchSpy.mock.calls[0][0]);
		expect(url).toContain('/v2/activities/staged?state=denied,expired_denied');
		expect(url).toContain('sort=desc');
		expect(ids).toEqual(['amateurism', 'fandom']);
	});

	it('degrades to an empty list rather than throwing', async () => {
		vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('network down'));

		await expect(getDeniedStagedActivityIds(createMockBindings())).resolves.toEqual([]);
	});
});

describe('retrieveActivityIds', () => {
	it('reads bare ids at 1000 per page', async () => {
		const bindings = createMockBindings();
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ items: ['chess', 'judo'], total: 2 }), { status: 200 })
			);

		const ids = await retrieveActivityIds(bindings);

		const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(`${bindings.MANTLE_URL}/v2/activities/list?limit=1000&page=1`);
		expect((init.headers as Record<string, string>).Authorization).toBe(
			`Bearer ${bindings.ADMIN_API_KEY}`
		);
		expect(ids).toEqual(['chess', 'judo']);
	});

	it('follows pagination until a short page', async () => {
		const full = Array.from({ length: 1000 }, (_, index) => `activity_${index}`);
		vi.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ items: full, total: 1002 }), { status: 200 })
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ items: ['tail_one', 'tail_two'], total: 1002 }), {
					status: 200
				})
			);

		const ids = await retrieveActivityIds(createMockBindings());

		expect(ids).toHaveLength(1002);
		expect(ids.at(-1)).toBe('tail_two');
	});

	it('treats a 404 as the end of the catalog', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response('No activities found', { status: 404 })
		);

		await expect(retrieveActivityIds(createMockBindings())).resolves.toEqual([]);
	});

	it('degrades to what it already has when a page fails', async () => {
		const full = Array.from({ length: 1000 }, (_, index) => `activity_${index}`);
		vi.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ items: full, total: 2000 }), { status: 200 })
			)
			.mockRejectedValueOnce(new Error('network down'));

		await expect(retrieveActivityIds(createMockBindings())).resolves.toHaveLength(1000);
	});

	it('ignores non-string entries', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(JSON.stringify({ items: ['chess', 42, null] }), { status: 200 })
		);

		await expect(retrieveActivityIds(createMockBindings())).resolves.toEqual(['chess']);
	});
});
