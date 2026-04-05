import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../src/app';
import { createMockBindings } from './helpers/mock-bindings';

function appRequest(path: string, init: RequestInit = {}, authenticated: boolean = true) {
	const headers = new Headers(init.headers);
	if (authenticated) {
		headers.set('Authorization', 'Bearer test-admin-key');
	}
	if (init.body && !headers.has('Content-Type')) {
		headers.set('Content-Type', 'application/json');
	}

	return new Request(`https://cloud.test${path}`, {
		...init,
		headers
	});
}

async function callApp(
	path: string,
	init: RequestInit = {},
	authenticated: boolean = true,
	bindings = createMockBindings()
) {
	const ctx = { waitUntil: vi.fn((promise: Promise<unknown>) => void promise) };
	return app.fetch(appRequest(path, init, authenticated), bindings, ctx as any);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('app route registration', () => {
	it('registers all expected API endpoints', () => {
		const routes = ((app as any).routes || []).map((r: any) => `${r.method} ${r.path}`);
		expect(routes).toEqual(
			expect.arrayContaining([
				'POST /admin/migrate-legacy-keys',
				'GET /synonyms',
				'GET /activity/:id',
				'GET /articles/search',
				'POST /articles/recommend_similar_articles',
				'POST /articles/grade',
				'GET /articles/quiz',
				'GET /articles/quiz/score',
				'POST /articles/quiz/submit',
				'POST /articles/quiz/create',
				'POST /prompts/grade',
				'POST /users/recommend_activities',
				'GET /users/profile_photo/:id',
				'PUT /users/profile_photo/:id',
				'POST /users/recommend_articles',
				'POST /users/timer',
				'GET /users/journey/activity/:id/count',
				'GET /users/journey/:type/leaderboard',
				'GET /users/journey/:type/:id/rank',
				'GET /users/journey/:type/:id',
				'POST /users/journey/activity/:id',
				'POST /users/journey/:type/:id/increment',
				'DELETE /users/journey/:type/:id/delete',
				'GET /users/badges',
				'GET /users/badges/:id',
				'GET /users/badges/:id/:badge_id',
				'POST /users/badges/:id/:badge_id/grant',
				'POST /users/badges/:id/track',
				'POST /users/badges/:id/:badge_id/progress',
				'DELETE /users/badges/:id/:badge_id/revoke',
				'DELETE /users/badges/:id/:badge_id/reset',
				'GET /users/impact_points/:id',
				'POST /users/impact_points/:id/add',
				'POST /users/impact_points/:id/remove',
				'PUT /users/impact_points/:id/set',
				'GET /users/quests',
				'GET /users/quests/:id',
				'POST /users/quests/progress/:user_id',
				'PATCH /users/quests/progress/:user_id',
				'DELETE /users/quests/progress/:user_id',
				'GET /users/quests/progress/:user_id',
				'GET /users/quests/progress/:user_id/step/:step_index',
				'GET /users/quests/history/:user_id',
				'GET /users/quests/history/:user_id/:quest_id',
				'GET /events/thumbnail/:id',
				'GET /events/thumbnail/:id/metadata',
				'POST /events/thumbnail/:id',
				'POST /events/thumbnail/:id/generate',
				'DELETE /events/thumbnail/:id',
				'POST /users/recommend_events',
				'POST /events/recommend_similar_events',
				'POST /events/submit_image',
				'GET /events/retrieve_image',
				'DELETE /events/delete_image'
			])
		);
	});
});

describe('app auth middleware', () => {
	it('rejects unauthenticated requests', async () => {
		const response = await callApp('/synonyms?word=earth', { method: 'GET' }, false);
		expect(response.status).toBe(401);
	});
});

describe('POST /admin/migrate-legacy-keys', () => {
	it('returns success with migrated count payload', async () => {
		const response = await callApp('/admin/migrate-legacy-keys', { method: 'POST' });
		expect(response.status).toBe(200);
		const json = await response.json<{ message: string; migrated_count: number }>();
		expect(json.message).toBe('Migration completed');
		expect(typeof json.migrated_count).toBe('number');
	});
});

describe('GET /synonyms', () => {
	it('returns 400 for missing or short words', async () => {
		const a = await callApp('/synonyms', { method: 'GET' });
		const b = await callApp('/synonyms?word=ab', { method: 'GET' });
		expect(a.status).toBe(400);
		expect(b.status).toBe(400);
	});
});

describe('GET /activity/:id', () => {
	it('returns 400 for invalid id length', async () => {
		const response = await callApp('/activity/ab', { method: 'GET' });
		expect(response.status).toBe(400);
	});
});

describe('GET /articles/search', () => {
	it('returns 400 for short query', async () => {
		const response = await callApp('/articles/search?q=ab', { method: 'GET' });
		expect(response.status).toBe(400);
	});
});

describe('POST /articles/recommend_similar_articles', () => {
	it('returns 400 for invalid request body', async () => {
		const response = await callApp('/articles/recommend_similar_articles', {
			method: 'POST',
			body: JSON.stringify({})
		});
		expect(response.status).toBe(400);
	});
});

describe('POST /articles/grade', () => {
	it('returns 400 when content is missing', async () => {
		const response = await callApp('/articles/grade', {
			method: 'POST',
			body: JSON.stringify({ id: '1' })
		});
		expect(response.status).toBe(400);
	});
});

describe('GET /articles/quiz', () => {
	it('returns 400 when article id is missing', async () => {
		const response = await callApp('/articles/quiz', { method: 'GET' });
		expect(response.status).toBe(400);
	});
});

describe('GET /articles/quiz/score', () => {
	it('returns 400 when ids are missing', async () => {
		const response = await callApp('/articles/quiz/score', { method: 'GET' });
		expect(response.status).toBe(400);
	});
});

describe('POST /articles/quiz/submit', () => {
	it('returns 400 when required fields are missing', async () => {
		const response = await callApp('/articles/quiz/submit', {
			method: 'POST',
			body: JSON.stringify({ articleId: '', userId: '', answers: null })
		});
		expect(response.status).toBe(400);
	});
});

describe('POST /users/timer', () => {
	it('returns 400 when action is missing', async () => {
		const response = await callApp('/users/timer', {
			method: 'POST',
			body: JSON.stringify({ userId: '1', field: 'articles_read_time:1' })
		});
		expect(response.status).toBe(400);
	});
});

describe('GET /users/journey/activity/:id/count', () => {
	it('returns 400 for non-numeric id', async () => {
		const response = await callApp('/users/journey/activity/abc/count', { method: 'GET' });
		expect(response.status).toBe(400);
	});
});

describe('POST /users/journey/activity/:id', () => {
	it('returns 400 when activity query is missing', async () => {
		const response = await callApp('/users/journey/activity/123', { method: 'POST' });
		expect(response.status).toBe(400);
	});
});

describe('GET /users/impact_points/:id', () => {
	it('returns 400 when id length is out of bounds', async () => {
		const response = await callApp('/users/impact_points/12', { method: 'GET' });
		expect(response.status).toBe(400);
	});
});

describe('POST /users/impact_points/:id/add', () => {
	it('returns 400 for non-positive point increments', async () => {
		const response = await callApp('/users/impact_points/123/add', {
			method: 'POST',
			body: JSON.stringify({ points: 0 })
		});
		expect(response.status).toBe(400);
	});
});

describe('PUT /users/impact_points/:id/set', () => {
	it('returns 400 for negative totals', async () => {
		const response = await callApp('/users/impact_points/123/set', {
			method: 'PUT',
			body: JSON.stringify({ points: -1 })
		});
		expect(response.status).toBe(400);
	});
});

describe('GET /users/quests', () => {
	it('returns quest catalog', async () => {
		const response = await callApp('/users/quests', { method: 'GET' });
		expect(response.status).toBe(200);
		const json = await response.json<unknown[]>();
		expect(Array.isArray(json)).toBe(true);
		expect(json.length).toBeGreaterThan(0);
	});
});

describe('GET /events/thumbnail/:id', () => {
	it('returns 400 for invalid event id', async () => {
		const response = await callApp('/events/thumbnail/not-a-number', { method: 'GET' });
		expect(response.status).toBe(400);
	});

	it('returns 404 when event thumbnail does not exist', async () => {
		const response = await callApp('/events/thumbnail/123', { method: 'GET' });
		expect(response.status).toBe(404);
	});
});

describe('GET /events/thumbnail/:id/metadata', () => {
	it('returns 400 for invalid event id', async () => {
		const response = await callApp('/events/thumbnail/not-a-number/metadata', { method: 'GET' });
		expect(response.status).toBe(400);
	});

	it('returns 404 when event thumbnail does not exist', async () => {
		const response = await callApp('/events/thumbnail/123/metadata', { method: 'GET' });
		expect(response.status).toBe(404);
	});
});

describe('POST /events/thumbnail/:id', () => {
	it('returns 400 for invalid event id', async () => {
		const response = await callApp('/events/thumbnail/nope', {
			method: 'POST',
			headers: { 'Content-Type': 'image/png' },
			body: new Uint8Array([1, 2, 3])
		});
		expect(response.status).toBe(400);
	});

	it('returns 400 for non-image content type', async () => {
		const response = await callApp('/events/thumbnail/123', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ image: 'nope' })
		});
		expect(response.status).toBe(400);
	});

	it('returns 400 for empty image payload', async () => {
		const response = await callApp('/events/thumbnail/123', {
			method: 'POST',
			headers: { 'Content-Type': 'image/png' },
			body: new Uint8Array()
		});
		expect(response.status).toBe(400);
	});

	it('supports upload, retrieval, metadata, and deletion lifecycle', async () => {
		const bindings = createMockBindings();

		const upload = await callApp(
			'/events/thumbnail/42',
			{
				method: 'POST',
				headers: { 'Content-Type': 'image/png' },
				body: new Uint8Array([10, 20, 30, 40])
			},
			true,
			bindings
		);
		expect(upload.status).toBe(204);

		const metadata = await callApp(
			'/events/thumbnail/42/metadata',
			{ method: 'GET' },
			true,
			bindings
		);
		expect(metadata.status).toBe(200);
		const metadataJson = await metadata.json<{ author: string; size: number }>();
		expect(metadataJson.author).toBe('<user>');
		expect(metadataJson.size).toBe(4);

		const thumbnail = await callApp('/events/thumbnail/42', { method: 'GET' }, true, bindings);
		expect(thumbnail.status).toBe(200);
		expect(thumbnail.headers.get('Content-Type')).toBe('image/webp');
		expect(thumbnail.headers.get('X-Event-Thumbnail-Author')).toBe('<user>');
		expect(await thumbnail.arrayBuffer()).toEqual(new Uint8Array([10, 20, 30, 40]).buffer);

		const del = await callApp('/events/thumbnail/42', { method: 'DELETE' }, true, bindings);
		expect(del.status).toBe(204);

		const afterDelete = await callApp('/events/thumbnail/42', { method: 'GET' }, true, bindings);
		expect(afterDelete.status).toBe(404);
	});
});

describe('POST /events/thumbnail/:id/generate', () => {
	it('returns 400 for invalid event id', async () => {
		const response = await callApp(
			'/events/thumbnail/not-a-number/generate?name=Bahamas%27%20Birthday',
			{
				method: 'POST'
			}
		);
		expect(response.status).toBe(400);
	});

	it('returns 400 when name is missing or too short', async () => {
		const missing = await callApp('/events/thumbnail/12/generate', { method: 'POST' });
		const short = await callApp('/events/thumbnail/12/generate?name=ab', { method: 'POST' });
		expect(missing.status).toBe(400);
		expect(short.status).toBe(400);
	});

	it('returns 400 for non-birthday event names', async () => {
		const response = await callApp('/events/thumbnail/12/generate?name=Earth%20Day%20Festival', {
			method: 'POST'
		});
		expect(response.status).toBe(400);
	});

	it('returns 404 when no place thumbnail is found', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response('maps failure', { status: 500 })
		);

		const response = await callApp('/events/thumbnail/12/generate?name=Bahamas%27%20Birthday', {
			method: 'POST'
		});

		expect(response.status).toBe(404);
	});

	it('generates, stores, and serves a birthday thumbnail when place photo exists', async () => {
		const bindings = createMockBindings();
		vi.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ places: [{ name: 'places/abc123' }] }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						photos: [
							{
								name: 'photos/p1',
								authorAttributions: [{ displayName: 'Photo Author' }]
							}
						]
					}),
					{
						status: 200,
						headers: { 'Content-Type': 'application/json' }
					}
				)
			)
			.mockResolvedValueOnce(
				new Response(new Uint8Array([1, 2, 3, 4, 5]), {
					status: 200,
					headers: { 'Content-Type': 'image/jpeg' }
				})
			);

		const response = await callApp(
			'/events/thumbnail/12/generate?name=Bahamas%27%20Birthday',
			{ method: 'POST' },
			true,
			bindings
		);
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe('image/webp');
		expect(response.headers.get('X-Event-Thumbnail-Author')).toBe('Photo Author');
		expect(await response.arrayBuffer()).toEqual(new Uint8Array([1, 2, 3, 4, 5]).buffer);

		const metadata = await callApp(
			'/events/thumbnail/12/metadata',
			{ method: 'GET' },
			true,
			bindings
		);
		expect(metadata.status).toBe(200);
		const metadataJson = await metadata.json<{ author: string; size: number }>();
		expect(metadataJson.author).toBe('Photo Author');
		expect(metadataJson.size).toBe(5);
	});

	it('returns 500 when thumbnail generation fails during image transformation', async () => {
		const brokenBindings = createMockBindings({
			IMAGES: {
				input: () => {
					throw new Error('transform failed');
				}
			} as any
		});
		vi.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ places: [{ name: 'places/abc123' }] }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ photos: [{ name: 'photos/p1' }] }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			)
			.mockResolvedValueOnce(
				new Response(new Uint8Array([1, 2, 3]), {
					status: 200,
					headers: { 'Content-Type': 'image/jpeg' }
				})
			);

		const response = await callApp(
			'/events/thumbnail/99/generate?name=Bahamas%27%20Birthday',
			{ method: 'POST' },
			true,
			brokenBindings
		);

		expect(response.status).toBe(500);
	});
});

describe('DELETE /events/thumbnail/:id', () => {
	it('returns 400 for invalid event id', async () => {
		const response = await callApp('/events/thumbnail/bad-id', { method: 'DELETE' });
		expect(response.status).toBe(400);
	});
});
