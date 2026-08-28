import { afterEach, describe, expect, it, vi } from 'vitest';

import app from '../src/app';
import { logAnalyticsBatch } from '../src/content/analytics';
import { createMockBindings } from './helpers/mock-bindings';
import { createMockAiRun } from './helpers/mock-ai';
import { Quest } from '../src/user/quests';
import { CustomQuest } from '../src/user/quests/custom';
import { API_DEVICE_METADATA } from '../src/user/quests/validation';
import type { Bindings } from '../src/util/types';

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
	const pending: Promise<unknown>[] = [];
	const ctx = {
		waitUntil: vi.fn((promise: Promise<unknown>) => {
			pending.push(
				promise.catch(() => {
					// Ignore background failures in tests unless assertions explicitly check for them.
				})
			);
		})
	};
	const response = await app.fetch(appRequest(path, init, authenticated), bindings, ctx as any);
	let processed = 0;
	while (processed < pending.length) {
		const current = pending.slice(processed);
		processed = pending.length;
		await Promise.allSettled(current);
	}
	return response;
}

afterEach(() => {
	vi.restoreAllMocks();
});

const sampleArticle = {
	id: '100000000000000000000123',
	title: 'Sustainable Transit in Growing Cities',
	description: 'How cities can reduce emissions while improving mobility.',
	tags: ['NATURE', 'TECHNOLOGY'],
	content:
		'City planners can combine protected bike infrastructure, electric transit, and walkable zoning to improve quality of life and reduce emissions.',
	author: {
		id: '1',
		username: 'cloud'
	},
	author_id: '1',
	color: 'green',
	color_hex: '#00aa55',
	created_at: new Date().toISOString(),
	ocean: {
		title: 'Transit and Climate',
		author: 'Research Team',
		source: 'Urban Science',
		url: 'https://example.com/ocean/transit',
		keywords: ['transit', 'climate'],
		date: '2026-01-01',
		links: {}
	}
} as const;

const sampleEvent = {
	id: '100000000000000000000555',
	name: "Bahamas' Birthday",
	description: 'A civic celebration featuring history and community stories.',
	type: 'ONLINE',
	date: Date.now(),
	end_date: Date.now() + 60 * 60 * 1000,
	visibility: 'PUBLIC',
	activities: [{ type: 'activity_type', value: 'NATURE' }],
	fields: {}
} as const;

const sampleProfilePrompt = {
	username: 'eco_user',
	bio: 'Loves sustainability and local projects.',
	created_at: '2026-01-01',
	visibility: 'PUBLIC',
	country: 'US',
	full_name: 'Eco User',
	activities: []
} as const;

const sampleActivity = {
	type: 'com.earthapp.activity.Activity',
	id: '100000000000000000000999',
	name: 'Tree Planting',
	description: 'Planting native trees in urban areas.',
	aliases: ['reforestation'],
	activity_types: ['NATURE']
} as const;

function toImageDataUrl(bytes: number[] = [137, 80, 78, 71, 1, 2, 3, 4]): string {
	return `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`;
}

describe('app route registration', () => {
	it('registers all expected API endpoints', () => {
		const routes = ((app as any).routes || []).map((r: any) => `${r.method} ${r.path}`);
		expect(routes).toEqual(
			expect.arrayContaining([
				'ALL /*',
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
				'DELETE /users/:id',
				'POST /users/recommend_activities',
				'GET /users/profile_photo/:id',
				'PUT /users/profile_photo/:id',
				'POST /users/recommend_articles',
				'POST /users/timer',
				'GET /users/journey/activity/:id/count',
				'GET /users/journey/:type/leaderboard',
				'POST /users/alias',
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
				'POST /users/quests/custom',
				'PATCH /users/quests/custom/:quest_id',
				'DELETE /users/quests/custom/:quest_id',
				'POST /users/quests/progress/:user_id/start',
				'PATCH /users/quests/progress/:user_id/update',
				'DELETE /users/quests/progress/:user_id/reset',
				'GET /users/quests/progress/:user_id',
				'GET /users/quests/progress/:user_id/step/:step_index',
				'GET /users/quests/history/:user_id',
				'GET /users/quests/history/:user_id/:quest_id',
				'DELETE /users/quests/history/:user_id',
				'DELETE /users/quests/history/:user_id/:quest_id',
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

describe('DELETE /users/:id', () => {
	it('deletes user-scoped KV and R2 data across badges, quizzes, journeys, quests, submissions, and profile blobs', async () => {
		const bindings = createMockBindings();
		const kv = bindings.KV as any;
		const r2 = bindings.R2 as any;

		await kv.put('user:badge:42:getting_started', JSON.stringify({ granted_at: Date.now() }));
		await kv.put('user:badge_tracker:42:article_quizzes_completed', JSON.stringify([]));
		await kv.put('article:quiz_score:42:100', JSON.stringify({ score: 100 }));
		await kv.put('journey:article:42', '3', { metadata: { lastWrite: Date.now(), streak: 3 } });
		await kv.put('journey:activities:42', JSON.stringify(['cleanup']));
		await kv.put('user:impact_points:42', JSON.stringify([{ reason: 'seed', difference: 5 }]));

		await kv.put(
			'user:quest_progress:42',
			JSON.stringify([
				{
					type: 'draw_picture',
					index: 0,
					submittedAt: Date.now(),
					r2Key: 'users/42/quests/q1/step_0_0.bin'
				}
			]),
			{ metadata: { questId: 'q1', currentStep: 1, completed: false } }
		);
		await kv.put('user:quest_history_index:42', JSON.stringify(['q1']));
		await kv.put(
			'user:quest_history:42:q1',
			JSON.stringify({ r2Key: 'users/42/quests/q1/history.bin', completedAt: Date.now() })
		);
		await kv.put(
			'custom_quest:cq1',
			JSON.stringify({ id: 'cq1', owner_id: '42', title: 'Owned Quest', reward: 10, steps: [] }),
			{ metadata: { id: 'cq1', owner_id: '42', title: 'Owned Quest', reward: 10 } }
		);

		await kv.put('event:submission:sub1', 'events/7/submissions/42_sub1.webp', {
			metadata: { eventId: '7', userId: '42', timestamp: Date.now() }
		});
		await kv.put('event:7:submission_ids', JSON.stringify(['sub1']));
		await kv.put('user:42:submission_ids', JSON.stringify(['sub1']));
		await kv.put('event:7:user:42:submission_ids', JSON.stringify(['sub1']));
		await kv.put('event:image:score:7:sub1', JSON.stringify({ score: 0.9 }));

		await r2.put('users/42/profile.png', new Uint8Array([1, 2, 3]));
		await r2.put('users/42/profile_32.png', new Uint8Array([1, 2, 3]));
		await r2.put('users/42/quests/q1/step_0_0.bin', new Uint8Array([4, 5, 6]));
		await r2.put('users/42/quests/q1/history.bin', new Uint8Array([7, 8, 9]));
		await r2.put('events/7/submissions/42_sub1.webp', new Uint8Array([9, 9, 9]));

		const response = await callApp('/users/42', { method: 'DELETE' }, true, bindings);
		expect(response.status).toBe(200);

		expect(await kv.get('user:badge:42:getting_started')).toBeNull();
		expect(await kv.get('user:badge_tracker:42:article_quizzes_completed')).toBeNull();
		expect(await kv.get('article:quiz_score:42:100')).toBeNull();
		expect(await kv.get('journey:article:42')).toBeNull();
		expect(await kv.get('journey:activities:42')).toBeNull();
		expect(await kv.get('user:impact_points:42')).toBeNull();
		expect(await kv.get('user:quest_progress:42')).toBeNull();
		expect(await kv.get('user:quest_history:42:q1')).toBeNull();
		expect(await kv.get('user:quest_history_index:42')).toBeNull();
		expect(await kv.get('custom_quest:cq1')).toBeNull();
		expect(await kv.get('event:submission:sub1')).toBeNull();
		expect(await kv.get('event:image:score:7:sub1')).toBeNull();

		expect(r2.has('users/42/profile.png')).toBe(false);
		expect(r2.has('users/42/profile_32.png')).toBe(false);
		expect(r2.has('users/42/quests/q1/step_0_0.bin')).toBe(false);
		expect(r2.has('users/42/quests/q1/history.bin')).toBe(false);
		expect(r2.has('events/7/submissions/42_sub1.webp')).toBe(false);

		const timerStub = (bindings.TIMER as any).__stubs.get('42');
		const notifierStub = (bindings.NOTIFIER as any).__stubs.get('users:42');
		expect(timerStub.fetch).toHaveBeenCalledWith('https://do/delete', { method: 'DELETE' });
		expect(notifierStub.fetch).toHaveBeenCalledWith('https://do/delete', { method: 'DELETE' });
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

	it('validates pool shape and clamps size constraints', async () => {
		// a non-array pool is structurally malformed and rejected
		const invalidFormat = await callApp('/articles/recommend_similar_articles', {
			method: 'POST',
			body: JSON.stringify({ article: sampleArticle, pool: {} })
		});
		expect(invalidFormat.status).toBe(400);

		// an empty pool is forgiven and returns an empty recommendation set
		const emptyPool = await callApp('/articles/recommend_similar_articles', {
			method: 'POST',
			body: JSON.stringify({ article: sampleArticle, pool: [] })
		});
		expect(emptyPool.status).toBe(200);
		expect(await emptyPool.json()).toEqual([]);

		// an oversized pool is clamped to 20 rather than rejected
		const oversizedPool = await callApp('/articles/recommend_similar_articles', {
			method: 'POST',
			body: JSON.stringify({
				article: sampleArticle,
				pool: Array.from({ length: 21 }, (_, i) => ({ ...sampleArticle, id: String(i + 1) }))
			})
		});
		expect(oversizedPool.status).toBe(200);
	});

	it('returns recommendations for valid article pools', async () => {
		const response = await callApp('/articles/recommend_similar_articles', {
			method: 'POST',
			body: JSON.stringify({
				article: sampleArticle,
				pool: [sampleArticle, { ...sampleArticle, id: '100000000000000000000124' }],
				limit: 2
			})
		});

		expect(response.status).toBe(200);
		const json = await response.json<Array<{ id: string }>>();
		expect(Array.isArray(json)).toBe(true);
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

describe('admin quest moderation routes', () => {
	async function seedHistory(
		bindings: ReturnType<typeof createMockBindings>,
		userId: string,
		questId: string
	) {
		const r2Key = `users/${userId}/quests/${questId}/history.bin`;
		await bindings.KV.put(
			`user:quest_history:${userId}:${questId}`,
			JSON.stringify({ r2Key, completedAt: Date.now() }),
			{
				metadata: { questId, completedAt: Date.now() }
			}
		);
		await bindings.KV.put(`user:quest_history_index:${userId}`, JSON.stringify([questId]));
		await bindings.R2.put(r2Key, new Uint8Array([1]));
	}

	it('DELETE /users/quests/history/:user_id/:quest_id removes one completed quest', async () => {
		const bindings = createMockBindings();
		await seedHistory(bindings, '810', 'fun_facts');

		const res = await callApp(
			'/users/quests/history/810/fun_facts',
			{ method: 'DELETE' },
			true,
			bindings
		);
		expect(res.status).toBe(204);
		expect(await bindings.KV.get('user:quest_history:810:fun_facts')).toBeNull();
	});

	it('DELETE /users/quests/history/:user_id/:quest_id 404s when not in history', async () => {
		const bindings = createMockBindings();
		const res = await callApp(
			'/users/quests/history/811/fun_facts',
			{ method: 'DELETE' },
			true,
			bindings
		);
		expect(res.status).toBe(404);
	});

	it('DELETE /users/quests/history/:user_id clears all completed quests', async () => {
		const bindings = createMockBindings();
		await seedHistory(bindings, '812', 'fun_facts');

		const res = await callApp('/users/quests/history/812', { method: 'DELETE' }, true, bindings);
		expect(res.status).toBe(204);
		expect(await bindings.KV.get('user:quest_history_index:812')).toBeNull();
	});

	it('DELETE /users/quests/progress/:user_id/reset?step removes a single step', async () => {
		const bindings = createMockBindings();
		await bindings.KV.put(
			'user:quest_progress:813',
			JSON.stringify([{ type: 'order_items', index: 0, submittedAt: Date.now() }]),
			{
				metadata: {
					questId: 'vegetable_head',
					currentStep: 1,
					completed: false,
					startedAt: Date.now()
				}
			}
		);

		const res = await callApp(
			'/users/quests/progress/813/reset?step=0',
			{ method: 'DELETE' },
			true,
			bindings
		);
		expect(res.status).toBe(200);
		const stored = await bindings.KV.getWithMetadata('user:quest_progress:813', 'json');
		expect((stored.value as any[]).length).toBe(0);
	});

	it('DELETE /users/quests/progress/:user_id/reset?step rejects an invalid step param', async () => {
		const bindings = createMockBindings();
		const res = await callApp(
			'/users/quests/progress/814/reset?step=-1',
			{ method: 'DELETE' },
			true,
			bindings
		);
		expect(res.status).toBe(400);
	});
});

describe('custom quests', () => {
	it('creates quests without accepting audit fields from the client', async () => {
		const response = await callApp('/users/quests/custom?user_id=123', {
			method: 'POST',
			body: JSON.stringify({
				id: 'my_quest',
				title: 'My Quest',
				description: 'Do a thing',
				icon: 'mdi:star',
				steps: [
					{
						type: 'article_quiz',
						description: 'Read an article.',
						parameters: ['TECHNOLOGY', 0.8]
					},
					{
						type: 'draw_picture',
						description: 'Draw a picture of Earth.',
						parameters: ['A picture of earth', 0.4]
					},
					{
						type: 'take_photo_validation',
						description: 'Describe how you help the planet.',
						parameters: ['Describe how you help the planet', 0.6]
					}
				],
				premium: false,
				custom: true,
				owner_id: '123',
				reward: 25
			} satisfies CustomQuest)
		});

		expect(response.status).toBe(201);
		const quest = await response.json<{
			id: string;
			owner_id: string;
		}>();
		expect(quest.owner_id).toBe('123');
		expect(quest.id).toBeDefined();
	});

	it('enforces ownership for update and delete', async () => {
		const bindings = createMockBindings();
		const create = await callApp(
			'/users/quests/custom?user_id=123',
			{
				method: 'POST',
				body: JSON.stringify({
					title: 'Owned Quest',
					description: 'Do a thing',
					icon: 'mdi:star',
					steps: [
						{
							type: 'article_quiz',
							description: 'Read an article.',
							parameters: ['TECHNOLOGY', 0.8]
						},
						{
							type: 'draw_picture',
							description: 'Draw a picture of Earth.',
							parameters: ['A picture of earth', 0.4]
						},
						{
							type: 'take_photo_validation',
							description: 'Describe how you help the planet.',
							parameters: ['Describe how you help the planet', 0.6]
						}
					],
					reward: 25
				})
			},
			true,
			bindings
		);
		expect(create.status).toBe(201);
		const created = await create.json<{ id: string }>();

		const forbiddenUpdate = await callApp(
			`/users/quests/custom/${created.id}?user_id=456`,
			{
				method: 'PATCH',
				body: JSON.stringify({ title: 'Hacked' })
			},
			true,
			bindings
		);
		expect(forbiddenUpdate.status).toBe(403);

		const missingUpdate = await callApp(
			'/users/quests/custom/does-not-exist?user_id=123',
			{
				method: 'PATCH',
				body: JSON.stringify({ title: 'Missing' })
			},
			true,
			bindings
		);
		expect(missingUpdate.status).toBe(404);

		const forbiddenDelete = await callApp(
			`/users/quests/custom/${created.id}?user_id=456`,
			{ method: 'DELETE' },
			true,
			bindings
		);
		expect(forbiddenDelete.status).toBe(403);

		const deleteResponse = await callApp(
			`/users/quests/custom/${created.id}?user_id=123`,
			{ method: 'DELETE' },
			true,
			bindings
		);
		expect(deleteResponse.status).toBe(204);
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

	it('returns 400 when source indicates a non-place birthday entry', async () => {
		const response = await callApp(
			'/events/thumbnail/12/generate?name=Apple%20Inc%27s%20Birthday&source=birthdays/companies.csv',
			{
				method: 'POST'
			}
		);
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
				new Response(
					JSON.stringify({ places: [{ name: 'places/abc123', types: ['locality', 'political'] }] }),
					{
						status: 200,
						headers: { 'Content-Type': 'application/json' }
					}
				)
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
				new Response(
					JSON.stringify({ places: [{ name: 'places/abc123', types: ['locality', 'political'] }] }),
					{
						status: 200,
						headers: { 'Content-Type': 'application/json' }
					}
				)
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

describe('PUT /users/profile_photo/:id', () => {
	it('stores generated profile photos for valid prompt data', async () => {
		const bindings = createMockBindings({
			AI: {
				run: vi.fn(
					async () =>
						new ReadableStream<Uint8Array>({
							start(controller) {
								// must clear MIN_PROFILE_BYTES (1024); sdxl output under 1KB is treated as corrupt
								controller.enqueue(new Uint8Array(2048).fill(7));
								controller.close();
							}
						})
				)
			} as any
		});

		const response = await callApp(
			'/users/profile_photo/222',
			{ method: 'PUT', body: JSON.stringify(sampleProfilePrompt) },
			true,
			bindings
		);
		expect(response.status).toBe(200);
		const json = await response.json<{ data: string }>();
		expect(json.data.startsWith('data:')).toBe(true);
	});

	it('rejects admin and invalid IDs', async () => {
		const adminPut = await callApp('/users/profile_photo/1', {
			method: 'PUT',
			body: JSON.stringify(sampleProfilePrompt)
		});
		expect(adminPut.status).toBe(400);

		const invalidId = await callApp('/users/profile_photo/abc', {
			method: 'PUT',
			body: JSON.stringify(sampleProfilePrompt)
		});
		expect(invalidId.status).toBe(400);
	});
});

describe('GET /users/profile_photo/:id', () => {
	it('returns generated profile photos when available', async () => {
		const bindings = createMockBindings({
			AI: {
				run: vi.fn(
					async () =>
						new ReadableStream<Uint8Array>({
							start(controller) {
								// must clear MIN_PROFILE_BYTES (1024); sdxl output under 1KB is treated as corrupt
								controller.enqueue(new Uint8Array(2048).fill(7));
								controller.close();
							}
						})
				)
			} as any
		});

		await callApp(
			'/users/profile_photo/222',
			{ method: 'PUT', body: JSON.stringify(sampleProfilePrompt) },
			true,
			bindings
		);

		const getPhoto = await callApp('/users/profile_photo/222?size=128', {}, true, bindings);
		expect(getPhoto.status).toBe(200);
		const getPhotoJson = await getPhoto.json<{ data: string }>();
		expect(getPhotoJson.data.startsWith('data:')).toBe(true);
	});

	it('rejects invalid ids and size values', async () => {
		const badSize = await callApp('/users/profile_photo/123?size=5000', { method: 'GET' });
		expect(badSize.status).toBe(400);

		const badId = await callApp('/users/profile_photo/abc', { method: 'GET' });
		expect(badId.status).toBe(400);
	});
});

// sdxl output under MIN_PROFILE_BYTES (1024) is treated as corrupt, so the stream must clear it
function imageAi() {
	return {
		run: vi.fn(
			async () =>
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new Uint8Array(2048).fill(7));
						controller.close();
					}
				})
		)
	} as never;
}

describe('if-then plan routes', () => {
	const body = (value: unknown) => ({ method: 'POST', body: JSON.stringify(value) });
	const PLAN_BODY = { places: ['Sycamore Park'], activities: [{ id: 'hiking', name: 'Hiking' }] };

	it('rejects a malformed user id', async () => {
		const bad = await callApp('/users/abc/plan/menu', body(PLAN_BODY));
		expect(bad.status).toBe(400);

		const zero = await callApp('/users/0/plan/menu', body(PLAN_BODY));
		expect(zero.status).toBe(400);
	});

	it('rejects a non-JSON body', async () => {
		const response = await callApp('/users/1/plan/menu', {
			method: 'POST',
			body: 'not json',
			headers: { 'Content-Type': 'application/json' }
		});
		expect(response.status).toBe(400);
	});

	// planning only pays off when the goal is already wanted, so the route refuses to build a menu
	// for a user who has declared no interests
	it('refuses a menu until the user has activities', async () => {
		const response = await callApp('/users/1/plan/menu', body({ places: ['Sycamore Park'] }));
		expect(response.status).toBe(409);

		const empty = await callApp('/users/1/plan/menu', body({ activities: [] }));
		expect(empty.status).toBe(409);
	});

	it('builds a menu, forms one plan, and refuses a second', async () => {
		const bindings = createMockBindings();

		const menuResponse = await callApp('/users/1/plan/menu', body(PLAN_BODY), true, bindings);
		expect(menuResponse.status).toBe(200);
		const menu = (await menuResponse.json()) as {
			cues: { id: string; text: string }[];
			responses: { id: string; text: string }[];
		};
		expect(menu.cues.length).toBeGreaterThan(0);
		expect(menu.responses.length).toBeGreaterThan(0);

		const selection = { cue_id: menu.cues[0]!.id, response_id: menu.responses[0]!.id };
		const formed = await callApp('/users/1/plan', body(selection), true, bindings);
		expect(formed.status).toBe(201);
		const plan = (await formed.json()) as { sentence: string; expires_at: number };
		expect(plan.sentence.startsWith('If ')).toBe(true);
		expect(plan.sentence).toContain(', then I will ');

		// the menu is consumed, so a repeat selection has nothing to link against
		const repeat = await callApp('/users/1/plan', body(selection), true, bindings);
		expect(repeat.status).toBe(409);
	});

	it('rejects a forged selection', async () => {
		const bindings = createMockBindings();
		await callApp('/users/1/plan/menu', body(PLAN_BODY), true, bindings);

		const response = await callApp(
			'/users/1/plan',
			body({ cue_id: 'forged', response_id: 'forged' }),
			true,
			bindings
		);
		expect(response.status).toBe(400);
	});

	it('never returns the plan text back to the client', async () => {
		const bindings = createMockBindings();
		const menuResponse = await callApp('/users/1/plan/menu', body(PLAN_BODY), true, bindings);
		const menu = (await menuResponse.json()) as {
			cues: { id: string; text: string }[];
			responses: { id: string; text: string }[];
		};
		await callApp(
			'/users/1/plan',
			body({ cue_id: menu.cues[0]!.id, response_id: menu.responses[0]!.id }),
			true,
			bindings
		);

		const status = await callApp('/users/1/plan/status', {}, true, bindings);
		expect(status.status).toBe(200);
		const text = await status.text();
		expect(text).toContain('"active":true');
		expect(text).not.toContain(menu.cues[0]!.text);
		expect(text).not.toContain(menu.responses[0]!.text);
	});

	it('marks a rehearsal once and 404s without an active plan', async () => {
		const bindings = createMockBindings();
		const missing = await callApp('/users/1/plan/rehearsed', { method: 'POST' }, true, bindings);
		expect(missing.status).toBe(404);

		const menuResponse = await callApp('/users/1/plan/menu', body(PLAN_BODY), true, bindings);
		const menu = (await menuResponse.json()) as {
			cues: { id: string }[];
			responses: { id: string }[];
		};
		await callApp(
			'/users/1/plan',
			body({ cue_id: menu.cues[0]!.id, response_id: menu.responses[0]!.id }),
			true,
			bindings
		);

		const marked = await callApp('/users/1/plan/rehearsed', { method: 'POST' }, true, bindings);
		expect(marked.status).toBe(200);
	});

	it('traces the outcome against minutes outside', async () => {
		const bindings = createMockBindings();
		const none = await callApp('/users/1/plan/outcome', {}, true, bindings);
		expect(await none.json()).toEqual({ formed: false });

		const menuResponse = await callApp('/users/1/plan/menu', body(PLAN_BODY), true, bindings);
		const menu = (await menuResponse.json()) as {
			cues: { id: string }[];
			responses: { id: string }[];
		};
		await callApp(
			'/users/1/plan',
			body({ cue_id: menu.cues[0]!.id, response_id: menu.responses[0]!.id }),
			true,
			bindings
		);

		const outcome = await callApp('/users/1/plan/outcome', {}, true, bindings);
		const traced = (await outcome.json()) as { formed: boolean; minutes_since_formation: number };
		expect(traced.formed).toBe(true);
		expect(traced.minutes_since_formation).toBe(0);
	});

	it('requires admin auth', async () => {
		const response = await callApp('/users/1/plan/status', {}, false);
		expect(response.status).toBe(401);
	});
});

describe('GET /users/:id/memories', () => {
	// the surface is "this day, an earlier year", so the fixtures are pinned to today's month/day
	function sameDayYearsAgo(years: number, hour = 9): number {
		const now = new Date();
		return Date.UTC(now.getUTCFullYear() - years, now.getUTCMonth(), now.getUTCDate(), hour);
	}

	async function seedHistory(bindings: Bindings, questId: string, completedAt: number) {
		await bindings.KV.put(`user:quest_history_index:1`, JSON.stringify([questId]));
		await bindings.KV.put(
			`user:quest_history:1:${questId}`,
			JSON.stringify({ r2Key: `users/1/quests/${questId}/history.bin`, completedAt })
		);
	}

	it('rejects a malformed user id', async () => {
		const bad = await callApp('/users/abc/memories');
		expect(bad.status).toBe(400);

		const zero = await callApp('/users/0/memories');
		expect(zero.status).toBe(400);
	});

	it('requires admin auth', async () => {
		const response = await callApp('/users/1/memories', {}, false);
		expect(response.status).toBe(401);
	});

	it('hands back an empty list when the user has no history on this day', async () => {
		const bindings = createMockBindings();
		await seedHistory(bindings, 'first_light_walk', Date.now());

		const response = await callApp('/users/1/memories', {}, true, bindings);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ memories: [] });
	});

	it('returns a quest completed on this day in an earlier year', async () => {
		const bindings = createMockBindings();
		await seedHistory(bindings, 'first_light_walk', sameDayYearsAgo(1));

		const response = await callApp('/users/1/memories', {}, true, bindings);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { memories: { id: string; photo?: boolean }[] };
		expect(body.memories).toHaveLength(1);
		expect(body.memories[0]).toMatchObject({
			kind: 'quest',
			id: 'first_light_walk',
			yearsAgo: 1,
			photo: true
		});
	});

	// rank only widens the journal cap; it must never be required to see a memory
	it('reads the trail journal, and a free rank still gets one', async () => {
		const bindings = createMockBindings();
		await bindings.KV.put(
			'trail_journal:1',
			JSON.stringify([
				{
					trailId: 'sit_spot_dawn',
					title: 'Dawn Sit Spot',
					practice: 'sit_spot',
					presenceMinutes: 20,
					reflection: { note: 'still cold out', mood: 'calm', at: 'x' },
					completedAt: new Date(sameDayYearsAgo(2)).toISOString()
				}
			])
		);

		const response = await callApp('/users/1/memories?rank=free', {}, true, bindings);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { memories: { kind: string; note?: string }[] };
		expect(body.memories).toHaveLength(1);
		expect(body.memories[0]).toMatchObject({ kind: 'trail', note: 'still cold out', yearsAgo: 2 });
	});
});

describe('POST /users/surprise_activity', () => {
	const pool = [
		{ id: 'chess', name: 'Chess', description: 'A strategy board game', activity_types: ['GAME'] },
		{ id: 'pottery', name: 'Pottery', description: 'Shaping clay by hand', activity_types: ['ART'] }
	];

	it('rejects a malformed body', async () => {
		const notJson = await callApp('/users/surprise_activity', {
			method: 'POST',
			body: 'nope',
			headers: { 'Content-Type': 'application/json' }
		});
		expect(notJson.status).toBe(400);

		const noAll = await callApp('/users/surprise_activity', {
			method: 'POST',
			body: JSON.stringify({ user: [] })
		});
		expect(noAll.status).toBe(400);

		const emptyAll = await callApp('/users/surprise_activity', {
			method: 'POST',
			body: JSON.stringify({ all: [] })
		});
		expect(emptyAll.status).toBe(400);
	});

	it('returns one distant activity with its pool size', async () => {
		const response = await callApp('/users/surprise_activity', {
			method: 'POST',
			body: JSON.stringify({
				all: pool,
				user: [
					{
						id: 'run',
						name: 'Running',
						description: 'Going for a run outdoors',
						activity_types: ['SPORT']
					}
				]
			})
		});

		expect(response.status).toBe(200);
		const body = (await response.json()) as { activity: { id: string }; pool: number };
		expect(['chess', 'pottery']).toContain(body.activity.id);
		expect(body.pool).toBe(2);
	});

	it('works for a user with no activities yet', async () => {
		const response = await callApp('/users/surprise_activity', {
			method: 'POST',
			body: JSON.stringify({ all: pool })
		});

		expect(response.status).toBe(200);
		expect((await response.json()) as { unrelated: boolean }).toMatchObject({ unrelated: true });
	});
});

describe('POST /users/:id/activities/changed', () => {
	it('rejects a non-numeric id and a body without activities', async () => {
		const badId = await callApp('/users/abc/activities/changed', {
			method: 'POST',
			body: JSON.stringify({ activities: [] })
		});
		expect(badId.status).toBe(400);

		const zeroId = await callApp('/users/0/activities/changed', {
			method: 'POST',
			body: JSON.stringify({ activities: [] })
		});
		expect(zeroId.status).toBe(400);

		const noBody = await callApp('/users/42/activities/changed', {
			method: 'POST',
			body: 'not json',
			headers: { 'Content-Type': 'application/json' }
		});
		expect(noBody.status).toBe(400);

		const noActivities = await callApp('/users/42/activities/changed', {
			method: 'POST',
			body: JSON.stringify({ username: 'earthy' })
		});
		expect(noActivities.status).toBe(400);
	});

	it('reports the diff and stores the snapshot the garden reads', async () => {
		const bindings = createMockBindings({ AI: imageAi() });

		const response = await callApp(
			'/users/42/activities/changed',
			{
				method: 'POST',
				body: JSON.stringify({
					username: 'earthy',
					bio: '',
					created_at: '2026-01-01',
					visibility: 'PUBLIC',
					country: 'US',
					full_name: 'Earth User',
					activities: [{ id: 'karting', name: 'Karting', types: ['SPORT'], aliases: [] }]
				})
			},
			true,
			bindings
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			changed: true,
			added: ['karting'],
			quests_surfaced: ['activity_quest_karting']
		});
		expect(await bindings.KV.get('user:activities:42')).toBe('["karting"]');
	});

	it('accepts an explicit activity_ids list', async () => {
		const bindings = createMockBindings({ AI: imageAi() });

		const response = await callApp(
			'/users/42/activities/changed',
			{
				method: 'POST',
				body: JSON.stringify({ activities: [], activity_ids: ['debate'] })
			},
			true,
			bindings
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ changed: true, added: ['debate'] });
	});
});

describe('POST /users/recommend_articles', () => {
	it('returns recommendations for valid pool/activity payloads', async () => {
		const response = await callApp('/users/recommend_articles', {
			method: 'POST',
			body: JSON.stringify({ pool: [sampleArticle], activities: ['nature'], limit: 1 })
		});
		expect(response.status).toBe(200);
		const json = await response.json<Array<{ id: string }>>();
		expect(json[0]?.id).toBe(sampleArticle.id);
	});

	it('rejects structurally malformed request payloads', async () => {
		// pool/activities must be arrays; missing or wrong-typed fields are rejected
		const malformedPayloads = [
			{ activities: ['nature'] },
			{ pool: [sampleArticle] },
			{ pool: [sampleArticle], activities: { a: 'b' } }
		];

		for (const payload of malformedPayloads) {
			const response = await callApp('/users/recommend_articles', {
				method: 'POST',
				body: JSON.stringify(payload)
			});
			expect(response.status).toBe(400);
		}
	});

	it('forgives out-of-range and empty payloads by clamping instead of rejecting', async () => {
		// empty/over-limit inputs are cleaned and return an empty set rather than a 400
		const forgivablePayloads = [
			{ pool: [], activities: ['nature'] },
			{ pool: [sampleArticle], activities: [] },
			{ pool: [sampleArticle], activities: Array.from({ length: 11 }, (_, i) => `a-${i}`) },
			{ pool: [sampleArticle], activities: [''] },
			{ pool: [{ id: '' }], activities: ['nature'] }
		];

		for (const payload of forgivablePayloads) {
			const response = await callApp('/users/recommend_articles', {
				method: 'POST',
				body: JSON.stringify(payload)
			});
			expect(response.status).toBe(200);
		}
	});
});

describe('POST /users/recommend_activities', () => {
	it('returns recommendations for valid activity payloads', async () => {
		const response = await callApp('/users/recommend_activities', {
			method: 'POST',
			body: JSON.stringify({
				all: [sampleActivity],
				user: [sampleActivity]
			})
		});

		expect(response.status).toBe(200);
		const json = await response.json<Array<{ id: string }>>();
		expect(Array.isArray(json)).toBe(true);
	});

	it('rejects malformed activity payloads', async () => {
		const badBodies = [{ all: {}, user: [] }, { user: [] }, { all: [] }, { all: [], user: [] }];

		for (const body of badBodies) {
			const response = await callApp('/users/recommend_activities', {
				method: 'POST',
				body: JSON.stringify(body)
			});
			expect(response.status).toBe(400);
		}
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

	it('returns 400 for unsupported actions', async () => {
		const response = await callApp('/users/timer', {
			method: 'POST',
			body: JSON.stringify({ action: 'pause', userId: '1', field: 'articles_read_time:1' })
		});
		expect(response.status).toBe(400);
	});

	it('forwards valid timer actions to the durable object', async () => {
		const response = await callApp('/users/timer', {
			method: 'POST',
			body: JSON.stringify({ action: 'start', userId: '222', field: 'articles_read_time:1' })
		});
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('ok');
	});

	it('forwards metadata to the timer durable object', async () => {
		const fetchSpy = vi.fn(async () => new Response('ok'));
		const bindings = createMockBindings({
			TIMER: {
				idFromName: (name: string) => name,
				get: () => ({
					fetch: fetchSpy
				})
			} as any
		});

		const metadata = {
			article: {
				id: 'article-1',
				author_id: 'author-1',
				title: 'Testing Metadata Forwarding'
			}
		};

		const response = await callApp(
			'/users/timer',
			{
				method: 'POST',
				body: JSON.stringify({
					action: 'start',
					userId: '222',
					field: 'articles_read_time:article-1',
					metadata
				})
			},
			true,
			bindings
		);

		expect(response.status).toBe(200);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
		const forwardedBody = JSON.parse(String(init.body)) as {
			metadata?: typeof metadata;
		};
		expect(forwardedBody.metadata).toEqual(metadata);
	});

	it('rejects missing timer user and field', async () => {
		const missingUser = await callApp('/users/timer', {
			method: 'POST',
			body: JSON.stringify({ action: 'start', field: 'articles_read_time:1' })
		});
		expect(missingUser.status).toBe(400);

		const missingField = await callApp('/users/timer', {
			method: 'POST',
			body: JSON.stringify({ action: 'start', userId: '123' })
		});
		expect(missingField.status).toBe(400);
	});
});

describe('GET /content_analytics/user/:id', () => {
	it('returns owner-scoped analytics and aggregate stats', async () => {
		const bindings = createMockBindings();

		await logAnalyticsBatch(
			'article-u1-a',
			'reader-1',
			[
				{
					category: 'article_read_time',
					value: 90,
					metadata: { author_id: '500', title: 'A' },
					includeTimingStats: true
				},
				{
					category: 'articles_clicked',
					value: 1,
					metadata: { author_id: '500' }
				}
			],
			bindings
		);

		await logAnalyticsBatch(
			'article-u1-b',
			'reader-2',
			[
				{
					category: 'article_read_time',
					value: 30,
					metadata: { author_id: '500', title: 'B' },
					includeTimingStats: true
				},
				{
					category: 'articles_clicked',
					value: 1,
					metadata: { author_id: '500' }
				}
			],
			bindings
		);

		await logAnalyticsBatch(
			'article-u2',
			'reader-3',
			[
				{
					category: 'article_read_time',
					value: 12,
					metadata: { author_id: '999', title: 'Other' },
					includeTimingStats: true
				}
			],
			bindings
		);

		const response = await callApp(
			'/content_analytics/user/500',
			{ method: 'GET' },
			true,
			bindings
		);
		expect(response.status).toBe(200);

		const body = await response.json<{
			owner_host: string;
			total_contents: number;
			content_ids: string[];
			analytics: Array<Record<string, unknown>>;
			aggregate: {
				article_read_time?: { total: number; average: number; p90: number; p99: number };
				articles_clicked?: { total: number };
			};
		}>();

		expect(body.owner_host).toBe('500');
		expect(body.total_contents).toBe(2);
		expect(body.analytics).toHaveLength(2);
		expect(body.content_ids).toEqual(expect.arrayContaining(['article-u1-a', 'article-u1-b']));
		expect(body.aggregate.article_read_time?.total).toBe(120);
		expect(body.aggregate.article_read_time?.average).toBe(60);
		expect(body.aggregate.article_read_time?.p90).toBe(90);
		expect(body.aggregate.article_read_time?.p99).toBe(90);
		expect(body.aggregate.articles_clicked?.total).toBe(2);
	});

	it('returns empty analytics for owners without content', async () => {
		const response = await callApp('/content_analytics/user/123456', { method: 'GET' });
		expect(response.status).toBe(200);

		const body = await response.json<{
			content_ids: string[];
			analytics: Array<Record<string, unknown>>;
			total_contents: number;
			aggregate: Record<string, unknown>;
		}>();

		expect(body.content_ids).toEqual([]);
		expect(body.analytics).toEqual([]);
		expect(body.total_contents).toBe(0);
		expect(body.aggregate).toEqual({});
	});
});

describe('GET /users/journey/:type/leaderboard', () => {
	it('returns 400 for unsupported or invalid journey types', async () => {
		const unsupported = await callApp('/users/journey/unknown/leaderboard', { method: 'GET' });
		expect(unsupported.status).toBe(400);

		const shortType = await callApp('/users/journey/ab/leaderboard', { method: 'GET' });
		expect(shortType.status).toBe(400);

		const longType = await callApp('/users/journey/' + 'a'.repeat(51) + '/leaderboard', {
			method: 'GET'
		});
		expect(longType.status).toBe(400);
	});

	it('returns leaderboard results for various limit values', async () => {
		const bindings = createMockBindings();
		for (const limit of [-1, 0, 5, 100, 251]) {
			const response = await callApp(
				`/users/journey/article/leaderboard?limit=${limit}`,
				{},
				true,
				bindings
			);
			expect(response.status).toBe(200);
		}
	});
});

describe('POST /users/journey/:type/:id/increment', () => {
	it('returns 400 for invalid journey types and ids', async () => {
		const unsupported = await callApp('/users/journey/unknown/123/increment', { method: 'POST' });
		expect(unsupported.status).toBe(400);

		const shortType = await callApp('/users/journey/ab/123/increment', { method: 'POST' });
		expect(shortType.status).toBe(400);

		const longType = await callApp('/users/journey/' + 'a'.repeat(51) + '/123/increment', {
			method: 'POST'
		});
		expect(longType.status).toBe(400);

		// a short numeric id is valid now: it is the canonical form of a padded id
		const overlongId = await callApp(`/users/journey/article/${'9'.repeat(51)}/increment`, {
			method: 'POST'
		});
		expect(overlongId.status).toBe(400);

		const nonNumericId = await callApp('/users/journey/article/abc/increment', { method: 'POST' });
		expect(nonNumericId.status).toBe(400);
	});

	it('increments journey counters for valid requests', async () => {
		const response = await callApp('/users/journey/article/123/increment', { method: 'POST' });
		expect([200, 201]).toContain(response.status);
	});

	it('preserves the streak when the same-day guard only bumps the TTL', async () => {
		const bindings = createMockBindings();
		await bindings.KV.put('journey:article:123', '2', {
			metadata: { streak: 2, lastWrite: Date.now() }
		});

		const response = await callApp(
			'/users/journey/article/123/increment',
			{ method: 'POST' },
			true,
			bindings
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ count: 2 });

		const stored = await bindings.KV.getWithMetadata<{ streak: number; lastWrite: number }>(
			'journey:article:123'
		);
		expect(stored.metadata?.streak).toBe(2);

		const follow = await callApp('/users/journey/article/123', {}, true, bindings);
		expect(await follow.json()).toMatchObject({ count: 2 });
	});
});

describe('GET /users/journey/:type/:id', () => {
	it('returns 400 for invalid journey types and ids', async () => {
		const unsupported = await callApp('/users/journey/unknown/123', { method: 'GET' });
		expect(unsupported.status).toBe(400);

		const shortType = await callApp('/users/journey/ab/123', { method: 'GET' });
		expect(shortType.status).toBe(400);

		const longType = await callApp('/users/journey/' + 'a'.repeat(51) + '/123', {
			method: 'GET'
		});
		expect(longType.status).toBe(400);

		// a short numeric id is valid now: it is the canonical form of a padded id
		const overlongId = await callApp(`/users/journey/article/${'9'.repeat(51)}`, { method: 'GET' });
		expect(overlongId.status).toBe(400);

		const nonNumericId = await callApp('/users/journey/article/abc', { method: 'GET' });
		expect(nonNumericId.status).toBe(400);
	});

	it('returns journey details after an increment', async () => {
		const bindings = createMockBindings();
		await callApp('/users/journey/article/123/increment', { method: 'POST' }, true, bindings);
		const response = await callApp('/users/journey/article/123', {}, true, bindings);
		expect(response.status).toBe(200);
	});

	it('reports the personal best so a client does not have to keep its own', async () => {
		const bindings = createMockBindings();
		await bindings.KV.put('journey:best:article:123', '9');

		const response = await callApp('/users/journey/article/123', {}, true, bindings);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { count: number; rank: number; best: number };
		expect(body.best).toBe(9);
	});

	it('reports a zero best with nothing on record', async () => {
		const bindings = createMockBindings();
		const response = await callApp('/users/journey/article/123', {}, true, bindings);
		const body = (await response.json()) as { best: number };
		expect(body.best).toBe(0);
	});
});

describe('uuid ids resolve to the same data as numeric ids', () => {
	const HEX = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('primes an alias so the account never pays for a lookup', async () => {
		const bindings = createMockBindings();
		const response = await callApp(
			'/users/alias',
			{ method: 'POST', body: JSON.stringify({ uuid: HEX, id: '000000000000000000000042' }) },
			true,
			bindings
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ uuid: HEX, id: '42' });
		expect(await bindings.KV.get(`user:alias:${HEX}`)).toBe('42');
	});

	it('rejects a malformed pair', async () => {
		const bad = await callApp('/users/alias', {
			method: 'POST',
			body: JSON.stringify({ uuid: 'nope', id: '42' })
		});
		expect(bad.status).toBe(400);

		const missing = await callApp('/users/alias', { method: 'POST', body: '{}' });
		expect(missing.status).toBe(400);
	});

	// the contract Gregory set: retrieving by either id returns the same object
	it('returns the same journey for the uuid and for the numeric id', async () => {
		const bindings = createMockBindings();
		await bindings.KV.put(`user:alias:${HEX}`, '42');
		await bindings.KV.put('journey:article:42', '6', {
			metadata: { streak: 6, lastWrite: 1 }
		});
		await bindings.KV.put('journey:best:article:42', '11');

		// the padded form is what mantle2 issued before the uuid switch, and it still resolves
		const viaNumeric = await callApp(
			'/users/journey/article/000000000000000000000042',
			{},
			true,
			bindings
		);
		const viaUuid = await callApp(`/users/journey/article/${HEX}`, {}, true, bindings);

		expect(viaNumeric.status).toBe(200);
		expect(viaUuid.status).toBe(200);
		expect(await viaUuid.json()).toEqual(await viaNumeric.json());
	});

	it('writes through the uuid to the same key the numeric id reads', async () => {
		const bindings = createMockBindings();
		await bindings.KV.put(`user:alias:${HEX}`, '42');

		const incremented = await callApp(
			`/users/journey/article/${HEX}/increment`,
			{ method: 'POST' },
			true,
			bindings
		);
		expect(incremented.status).toBe(201);

		const read = await callApp(
			'/users/journey/article/000000000000000000000042',
			{},
			true,
			bindings
		);
		expect(((await read.json()) as { count: number }).count).toBe(1);
	});

	it('resolves an unknown uuid through mantle2 once, then from kv', async () => {
		const bindings = createMockBindings();
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ id: '42' })
		} as unknown as Response);

		await callApp(`/users/journey/article/${HEX}`, {}, true, bindings);
		await callApp(`/users/journey/article/${HEX}`, {}, true, bindings);

		const lookups = fetchSpy.mock.calls.filter(([url]) => String(url).includes('/internal_id'));
		expect(lookups).toHaveLength(1);
		expect(await bindings.KV.get(`user:alias:${HEX}`)).toBe('42');
	});

	it('404s a uuid nothing can resolve rather than keying kv on it', async () => {
		const bindings = createMockBindings();
		vi.spyOn(globalThis, 'fetch').mockResolvedValue({
			ok: false,
			status: 404,
			json: async () => ({})
		} as unknown as Response);
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);

		const response = await callApp(`/users/journey/article/${HEX}`, {}, true, bindings);
		expect(response.status).toBe(404);
		expect(await bindings.KV.get(`journey:article:${HEX}`)).toBeNull();
	});

	it('still rejects a shape that is neither', async () => {
		const dashed = await callApp('/users/journey/article/a1b2c3d4-e5f6-0718-293a-4b5c6d7e8f90');
		expect(dashed.status).toBe(400);
		expect(await dashed.text()).toContain('uuid');
	});
});

describe('GET /users/journey/:type/:id/rank', () => {
	it('returns 400 for invalid journey types and ids', async () => {
		const unsupported = await callApp('/users/journey/unknown/123/rank', { method: 'GET' });
		expect(unsupported.status).toBe(400);

		const shortType = await callApp('/users/journey/ab/123/rank', { method: 'GET' });
		expect(shortType.status).toBe(400);

		const longType = await callApp('/users/journey/' + 'a'.repeat(51) + '/123/rank', {
			method: 'GET'
		});
		expect(longType.status).toBe(400);

		// a short numeric id is valid now: it is the canonical form of a padded id
		const overlongId = await callApp(`/users/journey/article/${'9'.repeat(51)}/rank`, {
			method: 'GET'
		});
		expect(overlongId.status).toBe(400);

		const nonNumericId = await callApp('/users/journey/article/abc/rank', { method: 'GET' });
		expect(nonNumericId.status).toBe(400);
	});

	it('returns rank payloads for valid users and journey types', async () => {
		const bindings = createMockBindings();
		await callApp('/users/journey/article/123/increment', { method: 'POST' }, true, bindings);
		const response = await callApp('/users/journey/article/123/rank', {}, true, bindings);
		expect(response.status).toBe(200);
	});
});

describe('POST /users/journey/activity/:id', () => {
	it('returns 400 when activity query is missing', async () => {
		const response = await callApp('/users/journey/activity/123', { method: 'POST' });
		expect(response.status).toBe(400);
	});

	it('adds unique activities for valid users', async () => {
		const response = await callApp('/users/journey/activity/123?activity=hiking', {
			method: 'POST'
		});
		expect([200, 201]).toContain(response.status);
	});
});

describe('GET /users/journey/activity/:id/count', () => {
	it('returns 400 for invalid activity journey ids', async () => {
		const nonNumeric = await callApp('/users/journey/activity/abc/count', { method: 'GET' });
		expect(nonNumeric.status).toBe(400);

		// a short numeric id is valid now: it is the canonical form of a padded id
		const dashedUuid = await callApp(
			'/users/journey/activity/a1b2c3d4-e5f6-0718-293a-4b5c6d7e8f90/count',
			{ method: 'GET' }
		);
		expect(dashedUuid.status).toBe(400);

		const longId = await callApp('/users/journey/activity/' + 'a'.repeat(51) + '/count', {
			method: 'GET'
		});
		expect(longId.status).toBe(400);
	});

	it('returns activity counts after adding activities', async () => {
		const bindings = createMockBindings();
		await callApp(
			'/users/journey/activity/123?activity=hiking',
			{ method: 'POST' },
			true,
			bindings
		);
		const response = await callApp('/users/journey/activity/123/count', {}, true, bindings);
		expect(response.status).toBe(200);
	});
});

describe('DELETE /users/journey/:type/:id/delete', () => {
	it('returns 400 for invalid journey types and ids', async () => {
		const unsupported = await callApp('/users/journey/unknown/123/delete', { method: 'DELETE' });
		expect(unsupported.status).toBe(400);

		const shortType = await callApp('/users/journey/ab/123/delete', { method: 'DELETE' });
		expect(shortType.status).toBe(400);

		const longType = await callApp('/users/journey/' + 'a'.repeat(51) + '/123/delete', {
			method: 'DELETE'
		});
		expect(longType.status).toBe(400);

		// a short numeric id is valid now: it is the canonical form of a padded id
		const overlongId = await callApp(`/users/journey/article/${'9'.repeat(51)}/delete`, {
			method: 'DELETE'
		});
		expect(overlongId.status).toBe(400);

		const nonNumericId = await callApp('/users/journey/article/abc/delete', { method: 'DELETE' });
		expect(nonNumericId.status).toBe(400);
	});

	it('resets journey state for valid users and journey types', async () => {
		const bindings = createMockBindings();
		await callApp('/users/journey/article/123/increment', { method: 'POST' }, true, bindings);
		const response = await callApp(
			'/users/journey/article/123/delete',
			{ method: 'DELETE' },
			true,
			bindings
		);
		expect(response.status).toBe(204);
	});
});

describe('GET /users/badges', () => {
	it('returns the badge catalog', async () => {
		const response = await callApp('/users/badges', { method: 'GET' });
		expect(response.status).toBe(200);
	});
});

describe('GET /users/badges/:id', () => {
	it('returns user badge states for valid IDs', async () => {
		const response = await callApp('/users/badges/123', { method: 'GET' });
		expect(response.status).toBe(200);
	});

	it('returns 400 for invalid user IDs', async () => {
		const nonNumericId = await callApp('/users/badges/abc', { method: 'GET' });
		expect(nonNumericId.status).toBe(400);

		const longId = await callApp('/users/badges/' + '1'.repeat(51), { method: 'GET' });
		expect(longId.status).toBe(400);
	});
});

describe('GET /users/badges/:id/:badge_id', () => {
	it('returns details for known badges and 404 for unknown badges', async () => {
		const known = await callApp('/users/badges/123/article_enthusiast', { method: 'GET' });
		expect(known.status).toBe(200);

		const unknown = await callApp('/users/badges/123/does_not_exist', { method: 'GET' });
		expect(unknown.status).toBe(404);
	});

	it('returns 400 for invalid user IDs', async () => {
		const nonNumericUserId = await callApp('/users/badges/abc/article_enthusiast', {
			method: 'GET'
		});
		expect(nonNumericUserId.status).toBe(400);

		const longUserId = await callApp('/users/badges/' + '1'.repeat(51) + '/article_enthusiast', {
			method: 'GET'
		});
		expect(longUserId.status).toBe(400);
	});

	it('returns 404 for unknown badge IDs', async () => {
		const response = await callApp('/users/badges/123/unknown_badge', { method: 'GET' });
		expect(response.status).toBe(404);
	});
});

describe('POST /users/badges/:id/:badge_id/grant', () => {
	it('grants one-time badges and rejects duplicates/progress-based grants', async () => {
		const bindings = createMockBindings();

		const granted = await callApp(
			'/users/badges/123/verified/grant',
			{ method: 'POST' },
			true,
			bindings
		);
		expect(granted.status).toBe(201);

		const duplicate = await callApp(
			'/users/badges/123/verified/grant',
			{ method: 'POST' },
			true,
			bindings
		);
		expect(duplicate.status).toBe(409);

		const progressBased = await callApp('/users/badges/123/article_enthusiast/grant', {
			method: 'POST'
		});
		expect(progressBased.status).toBe(400);
	});

	it('returns 400 for invalid user IDs', async () => {
		const nonNumericUserId = await callApp('/users/badges/abc/verified/grant', {
			method: 'POST'
		});
		expect(nonNumericUserId.status).toBe(400);

		const longUserId = await callApp('/users/badges/' + '1'.repeat(51) + '/verified/grant', {
			method: 'POST'
		});
		expect(longUserId.status).toBe(400);
	});

	it('returns 404 for unknown badge IDs', async () => {
		const response = await callApp('/users/badges/123/unknown_badge/grant', {
			method: 'POST'
		});
		expect(response.status).toBe(404);
	});
});

describe('POST /users/badges/:id/track', () => {
	it('tracks valid values and rejects invalid tracker payload types', async () => {
		const bindings = createMockBindings();
		const ok = await callApp(
			'/users/badges/123/track',
			{
				method: 'POST',
				body: JSON.stringify({ tracker_id: 'articles_read', value: ['a1', 'a2'] })
			},
			true,
			bindings
		);
		expect(ok.status).toBe(200);

		const badValue = await callApp(
			'/users/badges/123/track',
			{
				method: 'POST',
				body: JSON.stringify({ tracker_id: 'articles_read', value: { nope: true } })
			},
			true,
			bindings
		);
		expect(badValue.status).toBe(400);

		const badArray = await callApp(
			'/users/badges/123/track',
			{
				method: 'POST',
				body: JSON.stringify({ tracker_id: 'articles_read', value: ['ok', { nope: true }] })
			},
			true,
			bindings
		);
		expect(badArray.status).toBe(400);
	});

	it('silently rejects duplicate values for set-based trackers', async () => {
		const bindings = createMockBindings();
		const response = await callApp(
			'/users/badges/123/track',
			{
				method: 'POST',
				body: JSON.stringify({ tracker_id: 'articles_read', value: ['a1', 'a1'] })
			},
			true,
			bindings
		);

		expect(response.status).toBe(200);
		const tracker = await bindings.KV.get<{ date: number; value: string }[]>(
			'user:badge_tracker:123:articles_read',
			'json'
		);
		// Should store only one entry (duplicate silently rejected)
		expect(tracker).toHaveLength(1);
		expect(tracker?.[0]?.value).toBe('a1');
	});

	it('allows duplicate values for duplicate-aware trackers', async () => {
		const bindings = createMockBindings();
		const response = await callApp(
			'/users/badges/123/track',
			{
				method: 'POST',
				body: JSON.stringify({ tracker_id: 'impact_points_earned', value: [10, 10] })
			},
			true,
			bindings
		);

		expect(response.status).toBe(200);
		const tracker = await bindings.KV.get<{ date: number; value: number }[]>(
			'user:badge_tracker:123:impact_points_earned',
			'json'
		);
		expect(tracker?.[0]?.value).toBe(20);
	});

	it('returns 400 for invalid user IDs', async () => {
		const nonNumericUserId = await callApp('/users/badges/abc/track', {
			method: 'POST',
			body: JSON.stringify({ tracker_id: 'articles_read', value: ['a1'] })
		});
		expect(nonNumericUserId.status).toBe(400);

		const longUserId = await callApp('/users/badges/' + '1'.repeat(51) + '/track', {
			method: 'POST',
			body: JSON.stringify({ tracker_id: 'articles_read', value: ['a1'] })
		});
		expect(longUserId.status).toBe(400);
	});

	it('retursn 400 for missing tracker_id or value', async () => {
		const missingTrackerId = await callApp('/users/badges/123/track', {
			method: 'POST',
			body: JSON.stringify({ value: ['a1'] })
		});
		expect(missingTrackerId.status).toBe(400);

		const missingValue = await callApp('/users/badges/123/track', {
			method: 'POST',
			body: JSON.stringify({ tracker_id: 'articles_read' })
		});
		expect(missingValue.status).toBe(400);
	});

	it('returns 400 for unknown tracker IDs', async () => {
		const response = await callApp('/users/badges/123/track', {
			method: 'POST',
			body: JSON.stringify({ tracker_id: 'unknown_tracker', value: ['a1'] })
		});
		expect(response.status).toBe(400);
	});
});

describe('POST /users/badges/:id/:badge_id/progress', () => {
	it('records badge progress and rejects invalid progress value payloads', async () => {
		const bindings = createMockBindings();

		const ok = await callApp(
			'/users/badges/123/article_enthusiast/progress',
			{ method: 'POST', body: JSON.stringify({ value: ['a1', 'a2', 'a3'] }) },
			true,
			bindings
		);
		expect(ok.status).toBe(200);

		const badValue = await callApp(
			'/users/badges/123/article_enthusiast/progress',
			{ method: 'POST', body: JSON.stringify({ value: { nope: true } }) },
			true,
			bindings
		);
		expect(badValue.status).toBe(400);
	});

	it('silently rejects duplicate values for set-based badge progress', async () => {
		const bindings = createMockBindings();
		const response = await callApp(
			'/users/badges/123/article_enthusiast/progress',
			{ method: 'POST', body: JSON.stringify({ value: ['a1', 'a1'] }) },
			true,
			bindings
		);

		expect(response.status).toBe(200);
		const payload = await response.json<{ progress: number; granted: boolean }>();
		// Duplicate silently rejected, progress is 0.1 (only 1 unique article, need 10)
		expect(payload.progress).toBe(0.1);
		expect(payload.granted).toBe(false);
	});

	it('allows duplicate values for duplicate-aware badge progress', async () => {
		const bindings = createMockBindings();
		const response = await callApp(
			'/users/badges/123/bookworm/progress',
			{ method: 'POST', body: JSON.stringify({ value: [1800, 1800] }) },
			true,
			bindings
		);

		expect(response.status).toBe(200);
		const payload = await response.json<{ progress: number; granted: boolean }>();
		expect(payload.progress).toBe(1);
		expect(payload.granted).toBe(true);
	});

	it('grants badges when progress meets requirements', async () => {
		const bindings = createMockBindings();
		const progressResponse = await callApp(
			'/users/badges/123/article_enthusiast/progress',
			{
				method: 'POST',
				body: JSON.stringify({
					value: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'a10']
				})
			},
			true,
			bindings
		);
		expect(progressResponse.status).toBe(200);
		const progressJson = await progressResponse.json<{ granted: boolean; progress: number }>();
		expect(progressJson.progress).toBe(1);
		expect(progressJson.granted).toBe(true);
	});

	it('returns 400 for invalid user IDs', async () => {
		const nonNumericUserId = await callApp('/users/badges/abc/article_enthusiast/progress', {
			method: 'POST',
			body: JSON.stringify({ value: ['a1'] })
		});
		expect(nonNumericUserId.status).toBe(400);

		const longUserId = await callApp(
			'/users/badges/' + '1'.repeat(51) + '/article_enthusiast/progress',
			{
				method: 'POST',
				body: JSON.stringify({ value: ['a1'] })
			}
		);
		expect(longUserId.status).toBe(400);
	});

	it('returns 404 for unknown badge IDs', async () => {
		const response = await callApp('/users/badges/123/unknown_badge/progress', {
			method: 'POST',
			body: JSON.stringify({ value: ['a1'] })
		});
		expect(response.status).toBe(404);
	});

	it('returns 400 for non-progress badges', async () => {
		const response = await callApp('/users/badges/123/verified/progress', {
			method: 'POST',
			body: JSON.stringify({ value: ['a1'] })
		});
		expect(response.status).toBe(400);
	});

	it('returns 400 for non-string or non-numeric progress values', async () => {
		const bindings = createMockBindings();
		const badValue = await callApp(
			'/users/badges/123/article_enthusiast/progress',
			{ method: 'POST', body: JSON.stringify({ value: ['a1', { nope: true }] }) },
			true,
			bindings
		);
		expect(badValue.status).toBe(400);
	});
});

describe('DELETE /users/badges/:id/:badge_id/revoke', () => {
	it('revokes already granted badges', async () => {
		const bindings = createMockBindings();
		await callApp('/users/badges/123/verified/grant', { method: 'POST' }, true, bindings);
		const response = await callApp(
			'/users/badges/123/verified/revoke',
			{ method: 'DELETE' },
			true,
			bindings
		);
		expect(response.status).toBe(204);
	});

	it('returns 400 on invalid user IDs', async () => {
		const nonNumericUserId = await callApp('/users/badges/abc/verified/revoke', {
			method: 'DELETE'
		});
		expect(nonNumericUserId.status).toBe(400);

		const longUserId = await callApp('/users/badges/' + '1'.repeat(51) + '/verified/revoke', {
			method: 'DELETE'
		});
		expect(longUserId.status).toBe(400);
	});

	it('returns 404 for unknown badge IDs', async () => {
		const response = await callApp('/users/badges/123/unknown_badge/revoke', {
			method: 'DELETE'
		});
		expect(response.status).toBe(404);
	});
});

describe('DELETE /users/badges/:id/:badge_id/reset', () => {
	it('resets progress-based badges', async () => {
		const bindings = createMockBindings();
		await callApp(
			'/users/badges/123/article_enthusiast/progress',
			{ method: 'POST', body: JSON.stringify({ value: ['a1', 'a2'] }) },
			true,
			bindings
		);

		const response = await callApp(
			'/users/badges/123/article_enthusiast/reset',
			{ method: 'DELETE' },
			true,
			bindings
		);
		expect(response.status).toBe(204);
	});

	it('returns 400 on invalid user IDs', async () => {
		const nonNumericUserId = await callApp('/users/badges/abc/article_enthusiast/reset', {
			method: 'DELETE'
		});
		expect(nonNumericUserId.status).toBe(400);

		const longUserId = await callApp(
			'/users/badges/' + '1'.repeat(51) + '/article_enthusiast/reset',
			{ method: 'DELETE' }
		);
		expect(longUserId.status).toBe(400);
	});

	it('returns 404 for unknown badge IDs', async () => {
		const response = await callApp('/users/badges/123/unknown_badge/reset', {
			method: 'DELETE'
		});
		expect(response.status).toBe(404);
	});
});

describe('POST /users/impact_points/:id/add', () => {
	it('adds points and validates reason length constraints', async () => {
		const ok = await callApp('/users/impact_points/123/add', {
			method: 'POST',
			body: JSON.stringify({ points: 25, reason: 'quest reward' })
		});
		expect(ok.status).toBe(200);

		const tooLong = await callApp('/users/impact_points/123/add', {
			method: 'POST',
			body: JSON.stringify({ points: 10, reason: 'x'.repeat(201) })
		});
		expect(tooLong.status).toBe(400);
	});

	it('returns 400 for non-positive point increments', async () => {
		const response = await callApp('/users/impact_points/123/add', {
			method: 'POST',
			body: JSON.stringify({ points: 0 })
		});
		expect(response.status).toBe(400);
	});

	it('returns 400 on missing points', async () => {
		const response = await callApp('/users/impact_points/123/add', {
			method: 'POST',
			body: JSON.stringify({ reason: 'missing points' })
		});
		expect(response.status).toBe(400);
	});

	it('returns 400 for invalid user IDs', async () => {
		const nonNumericId = await callApp('/users/impact_points/abc/add', {
			method: 'POST',
			body: JSON.stringify({ points: 10, reason: 'invalid user id' })
		});
		expect(nonNumericId.status).toBe(400);

		const longId = await callApp('/users/impact_points/' + '1'.repeat(51) + '/add', {
			method: 'POST',
			body: JSON.stringify({ points: 10, reason: 'invalid user id' })
		});
		expect(longId.status).toBe(400);
	});
});

describe('POST /users/impact_points/:id/remove', () => {
	it('removes points and validates reason length constraints', async () => {
		const ok = await callApp('/users/impact_points/123/remove', {
			method: 'POST',
			body: JSON.stringify({ points: 5, reason: 'adjustment' })
		});
		expect(ok.status).toBe(200);

		const tooLong = await callApp('/users/impact_points/123/remove', {
			method: 'POST',
			body: JSON.stringify({ points: 10, reason: 'x'.repeat(201) })
		});
		expect(tooLong.status).toBe(400);
	});

	it('returns 400 for non-positive point decrements', async () => {
		const response = await callApp('/users/impact_points/123/remove', {
			method: 'POST',
			body: JSON.stringify({ points: 0 })
		});
		expect(response.status).toBe(400);
	});

	it('returns 400 on missing points', async () => {
		const response = await callApp('/users/impact_points/123/remove', {
			method: 'POST',
			body: JSON.stringify({ reason: 'missing points' })
		});
		expect(response.status).toBe(400);
	});

	it('returns 400 for invalid user IDs', async () => {
		const nonNumericId = await callApp('/users/impact_points/abc/remove', {
			method: 'POST',
			body: JSON.stringify({ points: 10, reason: 'invalid user id' })
		});
		expect(nonNumericId.status).toBe(400);

		const longId = await callApp('/users/impact_points/' + '1'.repeat(51) + '/remove', {
			method: 'POST',
			body: JSON.stringify({ points: 10, reason: 'invalid user id' })
		});
		expect(longId.status).toBe(400);
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

	it('sets points and validates reason length constraints', async () => {
		const ok = await callApp('/users/impact_points/123/set', {
			method: 'PUT',
			body: JSON.stringify({ points: 12, reason: 'manual set' })
		});
		expect(ok.status).toBe(200);

		const tooLong = await callApp('/users/impact_points/123/set', {
			method: 'PUT',
			body: JSON.stringify({ points: 10, reason: 'x'.repeat(201) })
		});
		expect(tooLong.status).toBe(400);
	});

	it('returns 400 on missing points', async () => {
		const response = await callApp('/users/impact_points/123/set', {
			method: 'PUT',
			body: JSON.stringify({ reason: 'missing points' })
		});
		expect(response.status).toBe(400);
	});

	it('returns 400 for invalid user IDs', async () => {
		const nonNumericId = await callApp('/users/impact_points/abc/set', {
			method: 'PUT',
			body: JSON.stringify({ points: 10, reason: 'invalid user id' })
		});
		expect(nonNumericId.status).toBe(400);

		const longId = await callApp('/users/impact_points/' + '1'.repeat(51) + '/set', {
			method: 'PUT',
			body: JSON.stringify({ points: 10, reason: 'invalid user id' })
		});
		expect(longId.status).toBe(400);
	});
});

describe('GET /users/impact_points/:id', () => {
	it('returns 400 for an id that is neither numeric nor a uuid', async () => {
		// '12' is a valid canonical id now; a dashed uuid never is
		const response = await callApp('/users/impact_points/a1b2c3d4-e5f6-0718-293a-4b5c6d7e8f90', {
			method: 'GET'
		});
		expect(response.status).toBe(400);
	});

	it('returns updated point totals after mutations', async () => {
		const bindings = createMockBindings();
		await callApp(
			'/users/impact_points/123/set',
			{ method: 'PUT', body: JSON.stringify({ points: 12, reason: 'manual set' }) },
			true,
			bindings
		);

		const response = await callApp('/users/impact_points/123', {}, true, bindings);
		expect(response.status).toBe(200);
		const json = await response.json<{ points: number }>();
		expect(json.points).toBe(12);
	});
});

describe('GET /users/quests/:id', () => {
	it('returns the requested quest definition when it exists', async () => {
		const response = await callApp('/users/quests/fun_facts', { method: 'GET' });
		expect(response.status).toBe(200);
	});

	it('returns 404 for unknown quest IDs', async () => {
		const response = await callApp('/users/quests/unknown_quest', { method: 'GET' });
		expect(response.status).toBe(404);
	});

	it('returns 400 for invalid quest IDs', async () => {
		const shortId = await callApp('/users/quests/ab', { method: 'GET' });
		expect(shortId.status).toBe(400);

		const longId = await callApp('/users/quests/' + 'a'.repeat(81), { method: 'GET' });
		expect(longId.status).toBe(400);
	});

	it('returns activity quest with deterministic structure for valid activity_quest IDs', async () => {
		// Mock the fetch to return an activity
		const mockActivity = {
			id: 'hiking_123',
			name: 'Hiking',
			description: 'An outdoor recreational activity',
			aliases: ['trekking', 'trail_walking'],
			types: ['NATURE', 'SPORT', 'HEALTH'],
			fields: { icon: 'material-symbols:hiking' }
		};

		vi.spyOn(global, 'fetch').mockResolvedValueOnce(
			new Response(JSON.stringify(mockActivity), { status: 200 })
		);

		const response = await callApp('/users/quests/activity_quest_hiking_123', { method: 'GET' });
		expect(response.status).toBe(200);

		const quest = await response.json<any>();
		expect(quest.id).toBe('activity_quest_hiking_123');
		expect(quest.title).toBe('Explore Hiking');
		expect(quest.icon).toBe('material-symbols:hiking');
		expect(quest.steps).toBeDefined();
		expect(Array.isArray(quest.steps)).toBe(true);

		// Validate step structure
		expect(quest.steps.length).toBeGreaterThan(0);
		const firstStep = Array.isArray(quest.steps[0]) ? quest.steps[0][0] : quest.steps[0];
		expect(firstStep).toHaveProperty('type');
		expect(firstStep).toHaveProperty('description');
		expect(firstStep).toHaveProperty('parameters');
	});

	it('validates activity quest step progression for activities with < 4 types', async () => {
		// Mock activity with 2 types (< 4)
		const mockActivity = {
			id: 'reading_101',
			name: 'Reading',
			description: 'A quiet activity involving books.',
			aliases: ['reading_books'],
			types: ['LEARNING', 'RELAXATION'],
			fields: {}
		};

		vi.spyOn(global, 'fetch').mockResolvedValueOnce(
			new Response(JSON.stringify(mockActivity), { status: 200 })
		);

		const response = await callApp('/users/quests/activity_quest_reading_101', { method: 'GET' });
		expect(response.status).toBe(200);

		const quest = await response.json<any>();
		const flatSteps = quest.steps.flat();
		const stepTypes = flatSteps.map((s: any) => s.type);

		// Should have photo validation, variable step 2, article quizzes for all types (step 3)
		expect(stepTypes[0]).toBe('take_photo_validation');

		// Article quizzes: step 3 has both types at 80%, final step re-quizzes last type at 100%
		const articleQuizzes = flatSteps.filter((s: any) => s.type === 'article_quiz');
		expect(articleQuizzes.length).toBeGreaterThanOrEqual(2); // At least 2 for the 2 types

		// Verify match_terms and order_items are present for variety with < 4 types
		expect(stepTypes).toContain('match_terms');
		expect(stepTypes).toContain('order_items');

		// Verify final step has 100% accuracy requirement
		const finalArticleQuiz = articleQuizzes[articleQuizzes.length - 1];
		expect(finalArticleQuiz.parameters[1]).toBe(1.0); // 100% accuracy for final step
	});

	it('validates activity quest step progression for activities with >= 4 types', async () => {
		// Mock activity with 5 types (>= 4)
		const mockActivity = {
			id: 'sports_456',
			name: 'Sports',
			description:
				'Physical activities involving skill and exertion. Sports can be competitive or recreational. People engage in sports for fitness, entertainment, social connection, and personal achievement. There are many different types of sports ranging from team-based activities to individual pursuits.',
			aliases: ['athletics'],
			types: ['SPORT', 'HEALTH', 'SOCIAL', 'RECREATION', 'ENTERTAINMENT'],
			fields: {}
		};

		vi.spyOn(global, 'fetch').mockResolvedValueOnce(
			new Response(JSON.stringify(mockActivity), { status: 200 })
		);

		const response = await callApp('/users/quests/activity_quest_sports_456', { method: 'GET' });
		expect(response.status).toBe(200);

		const quest = await response.json<any>();
		const flatSteps = quest.steps.flat();
		const stepTypes = flatSteps.map((s: any) => s.type);

		// Should have at least match_terms and order_items for variety
		expect(stepTypes).toContain('match_terms');
		expect(stepTypes).toContain('order_items');

		// For 5 types: step 3 covers last 3, step 5 covers first 2 (uncovered)
		// Final step re-quizzes last type at 100% accuracy for mastery
		const articleQuizzes = flatSteps.filter((s: any) => s.type === 'article_quiz');
		expect(articleQuizzes.length).toBe(6); // 5 types + 1 duplicate (last type at 100%)

		// Verify all types are covered at least once
		const allArticleTypes = articleQuizzes.map((s: any) => s.parameters?.[0]);
		const uniqueTypes = new Set(allArticleTypes);
		expect(uniqueTypes.size).toBe(5); // All 5 types covered

		// Verify final step is at 100% accuracy
		const finalArticleQuiz = articleQuizzes[articleQuizzes.length - 1];
		expect(finalArticleQuiz.parameters[1]).toBe(1.0);
		expect(finalArticleQuiz.parameters[0]).toBe('ENTERTAINMENT'); // Last type (index 4)
	});
});

describe('POST /users/quests/progress/:user_id/start', () => {
	it('starts quest progress for valid users and quest IDs', async () => {
		const response = await callApp('/users/quests/progress/123/start', {
			method: 'POST',
			body: JSON.stringify({ quest_id: 'fun_facts' })
		});
		expect(response.status).toBe(201);
	});

	it('returns 400 for invalid user IDs', async () => {
		const nonNumericId = await callApp('/users/quests/progress/abc/start', {
			method: 'POST',
			body: JSON.stringify({ quest_id: 'fun_facts' })
		});
		expect(nonNumericId.status).toBe(400);

		const longId = await callApp('/users/quests/progress/' + '1'.repeat(51) + '/start', {
			method: 'POST',
			body: JSON.stringify({ quest_id: 'fun_facts' })
		});
		expect(longId.status).toBe(400);
	});

	it('returns 404 for invalid quest IDs', async () => {
		const shortQuestId = await callApp('/users/quests/progress/123/start', {
			method: 'POST',
			body: JSON.stringify({ quest_id: 'ab' })
		});
		expect(shortQuestId.status).toBe(404);

		const longQuestId = await callApp('/users/quests/progress/123/start', {
			method: 'POST',
			body: JSON.stringify({ quest_id: 'a'.repeat(51) })
		});
		expect(longQuestId.status).toBe(404);
	});

	it('returns 404 for unknown quest IDs', async () => {
		const response = await callApp('/users/quests/progress/123/start', {
			method: 'POST',
			body: JSON.stringify({ quest_id: 'unknown_quest' })
		});
		expect(response.status).toBe(404);
	});

	it('enforces rank requirements for premium quests', async () => {
		const missingRank = await callApp('/users/quests/progress/123/start', {
			method: 'POST',
			body: JSON.stringify({ quest_id: 'chicagoland' })
		});
		expect(missingRank.status).toBe(400);

		const freeRank = await callApp('/users/quests/progress/123/start', {
			method: 'POST',
			body: JSON.stringify({ quest_id: 'chicagoland', rank: 'free' })
		});
		expect(freeRank.status).toBe(403);

		const validRank = await callApp('/users/quests/progress/123/start', {
			method: 'POST',
			body: JSON.stringify({ quest_id: 'chicagoland', rank: 'gold' })
		});
		expect(validRank.status).toBe(201);
	});
});

describe('PATCH /users/quests/progress/:user_id/update', () => {
	it('updates article quiz progress for a valid active quest', async () => {
		const bindings = createMockBindings();

		await callApp(
			'/users/quests/progress/123/start',
			{ method: 'POST', body: JSON.stringify({ quest_id: 'fun_facts' }) },
			true,
			bindings
		);

		await bindings.KV.put(
			'article:quiz_score:123:100',
			JSON.stringify({ score: 9, scorePercent: 90, total: 10 })
		);

		const response = await callApp(
			'/users/quests/progress/123/update',
			{
				method: 'PATCH',
				body: JSON.stringify({
					device: API_DEVICE_METADATA,
					response: {
						type: 'article_quiz',
						index: 0,
						scoreKey: 'article:quiz_score:123:100',
						score: 90
					}
				})
			},
			true,
			bindings
		);

		expect(response.status).toBe(200);
	});

	it('covers request parsing, binary validation, and delay-gate branches', async () => {
		const invalidJson = await callApp('/users/quests/progress/123/update', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: '{'
		});
		expect(invalidJson.status).toBe(400);

		const missingDataUrl = await callApp('/users/quests/progress/123/update', {
			method: 'PATCH',
			body: JSON.stringify({
				device: API_DEVICE_METADATA,
				response: { type: 'take_photo_caption', index: 0 }
			})
		});
		expect(missingDataUrl.status).toBe(400);

		const invalidDataUrl = await callApp('/users/quests/progress/123/update', {
			method: 'PATCH',
			body: JSON.stringify({
				device: API_DEVICE_METADATA,
				response: { type: 'take_photo_caption', index: 0, dataUrl: 'not-a-data-url' }
			})
		});
		expect(invalidDataUrl.status).toBe(400);

		const unsupportedAudio = await callApp('/users/quests/progress/123/update', {
			method: 'PATCH',
			body: JSON.stringify({
				device: API_DEVICE_METADATA,
				response: {
					type: 'transcribe_audio',
					index: 0,
					dataUrl: `data:audio/mp3;base64,${btoa('not-real-audio')}`
				}
			})
		});
		expect(unsupportedAudio.status).toBe(415);

		const missingDevice = await callApp('/users/quests/progress/123/update', {
			method: 'PATCH',
			body: JSON.stringify({ response: { type: 'order_items', index: 0 } })
		});
		expect(missingDevice.status).toBe(400);

		const missingResponse = await callApp('/users/quests/progress/123/update', {
			method: 'PATCH',
			body: JSON.stringify({ device: API_DEVICE_METADATA })
		});
		expect(missingResponse.status).toBe(400);

		const bindings = createMockBindings();
		await bindings.KV.put(
			'user:quest_progress:123',
			JSON.stringify([{}, {}, {}, { submittedAt: Date.now() }]),
			{
				metadata: { questId: 'fun_facts', currentStep: 4, completed: false, startedAt: Date.now() }
			}
		);

		const delayed = await callApp(
			'/users/quests/progress/123/update',
			{
				method: 'PATCH',
				body: JSON.stringify({
					device: API_DEVICE_METADATA,
					response: { type: 'order_items', index: 4 }
				})
			},
			true,
			bindings
		);
		expect(delayed.status).toBe(425);
	});

	it('returns 404 when no active quest exists for the user', async () => {
		const response = await callApp('/users/quests/progress/123/update', {
			method: 'PATCH',
			body: JSON.stringify({
				device: API_DEVICE_METADATA,
				response: {
					type: 'article_quiz',
					index: 0,
					scoreKey: 'article:quiz_score:123:100',
					score: 90
				}
			})
		});
		expect(response.status).toBe(404);
	});

	it('returns 400 for invalid user IDs', async () => {
		const response = await callApp('/users/quests/progress/abc/update', {
			method: 'PATCH',
			body: JSON.stringify({
				device: API_DEVICE_METADATA,
				response: {
					type: 'article_quiz',
					index: 0,
					scoreKey: 'article:quiz_score:abc:100',
					score: 90
				}
			})
		});
		expect(response.status).toBe(400);
	});

	it('requires non-free rank for premium quest updates and resets progress on free rank', async () => {
		const bindings = createMockBindings();

		const started = await callApp(
			'/users/quests/progress/123/start',
			{ method: 'POST', body: JSON.stringify({ quest_id: 'chicagoland', rank: 'gold' }) },
			true,
			bindings
		);
		expect(started.status).toBe(201);

		const missingRank = await callApp(
			'/users/quests/progress/123/update',
			{
				method: 'PATCH',
				body: JSON.stringify({
					device: API_DEVICE_METADATA,
					response: {
						type: 'take_photo_location',
						index: 0,
						dataUrl: toImageDataUrl([255, 216, 255, 224])
					}
				})
			},
			true,
			bindings
		);
		expect(missingRank.status).toBe(400);

		const freeRank = await callApp(
			'/users/quests/progress/123/update',
			{
				method: 'PATCH',
				body: JSON.stringify({
					rank: 'free',
					device: API_DEVICE_METADATA,
					response: {
						type: 'take_photo_location',
						index: 0,
						dataUrl: toImageDataUrl([255, 216, 255, 224])
					}
				})
			},
			true,
			bindings
		);
		expect(freeRank.status).toBe(403);

		const afterReset = await callApp('/users/quests/progress/123', {}, true, bindings);
		expect(afterReset.status).toBe(200);
		const afterResetJson = await afterReset.json<{
			questId: string | null;
			progress: unknown[];
		}>();
		expect(afterResetJson.questId).toBeNull();
		expect(afterResetJson.progress).toEqual([]);
	});
});

describe('GET /users/quests/progress/:user_id', () => {
	it('retrieves active quest progress for users with an active quest', async () => {
		const bindings = createMockBindings();
		await callApp(
			'/users/quests/progress/123',
			{ method: 'POST', body: JSON.stringify({ quest_id: 'fun_facts' }) },
			true,
			bindings
		);

		const response = await callApp('/users/quests/progress/123', {}, true, bindings);
		expect(response.status).toBe(200);
	});
});

describe('GET /users/quests/progress/:user_id/step/:step_index', () => {
	it('retrieves step progress for reached steps', async () => {
		const bindings = createMockBindings();
		await callApp(
			'/users/quests/progress/123/start',
			{ method: 'POST', body: JSON.stringify({ quest_id: 'fun_facts' }) },
			true,
			bindings
		);

		await bindings.KV.put(
			'article:quiz_score:123:100',
			JSON.stringify({ score: 9, scorePercent: 90, total: 10 })
		);
		await callApp(
			'/users/quests/progress/123/update',
			{
				method: 'PATCH',
				body: JSON.stringify({
					device: API_DEVICE_METADATA,
					response: {
						type: 'article_quiz',
						index: 0,
						scoreKey: 'article:quiz_score:123:100',
						score: 90
					}
				})
			},
			true,
			bindings
		);

		const response = await callApp('/users/quests/progress/123/step/0', {}, true, bindings);
		expect(response.status).toBe(200);
	});
});

describe('GET /users/quests/history/:user_id', () => {
	it('returns quest history payloads for users', async () => {
		const response = await callApp('/users/quests/history/123', { method: 'GET' });
		expect(response.status).toBe(200);
	});
});

describe('GET /users/quests/history/:user_id/:quest_id', () => {
	it('returns 404 when completed quest history does not exist', async () => {
		const response = await callApp('/users/quests/history/123/fun_facts', { method: 'GET' });
		expect([200, 404]).toContain(response.status);
	});
});

describe('DELETE /users/quests/progress/:user_id', () => {
	it('resets active quest progress', async () => {
		const bindings = createMockBindings();
		const start = await callApp(
			'/users/quests/progress/123/start',
			{ method: 'POST', body: JSON.stringify({ quest_id: 'fun_facts' }) },
			true,
			bindings
		);
		expect(start.status).toBe(201);

		const progressAfterStart = await callApp('/users/quests/progress/123', {}, true, bindings);
		expect(progressAfterStart.status).toBe(200);
		const progressJson = await progressAfterStart.json<{ questId: string | null }>();
		expect(progressJson.questId).toBe('fun_facts');

		const end = await callApp(
			'/users/quests/progress/123/reset',
			{ method: 'DELETE' },
			true,
			bindings
		);
		expect(end.status).toBe(204);

		const progressAfterReset = await callApp('/users/quests/progress/123', {}, true, bindings);
		expect(progressAfterReset.status).toBe(200);
		const progressAfterResetJson = await progressAfterReset.json<{ questId: string | null }>();
		expect(progressAfterResetJson.questId).toBeNull();
	});
});

describe('POST /users/recommend_events', () => {
	it('returns recommendations for valid event/activity payloads', async () => {
		const response = await callApp('/users/recommend_events', {
			method: 'POST',
			body: JSON.stringify({ pool: [sampleEvent], activities: ['nature'], limit: 1 })
		});
		expect(response.status).toBe(200);
	});

	it('rejects structurally malformed request payloads', async () => {
		// pool/activities must be arrays; missing or wrong-typed fields are rejected
		const malformedPayloads = [
			{ activities: ['nature'] },
			{ pool: [sampleEvent] },
			{ pool: [sampleEvent], activities: { a: 'b' } }
		];

		for (const payload of malformedPayloads) {
			const response = await callApp('/users/recommend_events', {
				method: 'POST',
				body: JSON.stringify(payload)
			});
			expect(response.status).toBe(400);
		}
	});

	it('forgives out-of-range and empty payloads by clamping instead of rejecting', async () => {
		// empty/over-limit inputs are cleaned and return a result rather than a 400
		const forgivablePayloads = [
			{ pool: [], activities: ['nature'] },
			{ pool: [sampleEvent], activities: [] },
			{ pool: [sampleEvent], activities: [''] },
			{ pool: [{ id: '' }], activities: ['nature'] },
			{ pool: Array.from({ length: 21 }, () => sampleEvent), activities: ['nature'] }
		];

		for (const payload of forgivablePayloads) {
			const response = await callApp('/users/recommend_events', {
				method: 'POST',
				body: JSON.stringify(payload)
			});
			expect(response.status).toBe(200);
		}
	});
});

describe('POST /events/recommend_similar_events', () => {
	it('returns recommendations for valid event pools', async () => {
		const response = await callApp('/events/recommend_similar_events', {
			method: 'POST',
			body: JSON.stringify({ event: sampleEvent, pool: [sampleEvent], limit: 1 })
		});
		expect(response.status).toBe(200);
	});

	it('clamps oversized pools for similarity recommendations instead of rejecting', async () => {
		const response = await callApp('/events/recommend_similar_events', {
			method: 'POST',
			body: JSON.stringify({
				event: sampleEvent,
				pool: Array.from({ length: 21 }, () => sampleEvent)
			})
		});
		expect(response.status).toBe(200);
	});
});

describe('POST /events/submit_image', () => {
	it('accepts valid event image submissions and returns submission IDs', async () => {
		const bindings = createMockBindings({
			AI: {
				run: createMockAiRun()
			} as any
		});

		const response = await callApp(
			'/events/submit_image',
			{
				method: 'POST',
				body: JSON.stringify({
					user_id: '777',
					event: sampleEvent,
					photo_url: toImageDataUrl()
				})
			},
			true,
			bindings
		);
		expect(response.status).toBe(201);
		const json = await response.json<{ submission_id: string; success: boolean }>();
		expect(json.success).toBe(true);
		expect(json.submission_id).toHaveLength(32);
	});
});

describe('GET /events/retrieve_image', () => {
	it('retrieves submitted images by submission id and list filters', async () => {
		const bindings = createMockBindings({
			AI: {
				run: createMockAiRun()
			} as any
		});

		const submit = await callApp(
			'/events/submit_image',
			{
				method: 'POST',
				body: JSON.stringify({
					user_id: '777',
					event: sampleEvent,
					photo_url: toImageDataUrl()
				})
			},
			true,
			bindings
		);
		const submitJson = await submit.json<{ submission_id: string }>();

		const single = await callApp(
			`/events/retrieve_image?submission_id=${submitJson.submission_id}`,
			{},
			true,
			bindings
		);
		expect(single.status).toBe(200);

		const list = await callApp(
			'/events/retrieve_image?event_id=100000000000000000000555&user_id=777&limit=25&page=1&sort=desc',
			{},
			true,
			bindings
		);
		expect(list.status).toBe(200);
	});

	it('rejects invalid retrieve image query parameter combinations', async () => {
		const requests = [
			'/events/retrieve_image',
			'/events/retrieve_image?submission_id=abc',
			'/events/retrieve_image?event_id=abc',
			'/events/retrieve_image?event_id=1&limit=0',
			'/events/retrieve_image?event_id=1&sort=up',
			'/events/retrieve_image?user_id=abc',
			'/events/retrieve_image?event_id=1&page=0',
			'/events/retrieve_image?event_id=1&limit=501'
		];

		for (const path of requests) {
			const response = await callApp(path, { method: 'GET' });
			expect(response.status).toBe(400);
		}
	});
});

describe('DELETE /events/delete_image', () => {
	it('deletes single and bulk image submissions', async () => {
		const bindings = createMockBindings({
			AI: {
				run: createMockAiRun()
			} as any
		});

		const submit = await callApp(
			'/events/submit_image',
			{
				method: 'POST',
				body: JSON.stringify({
					user_id: '777',
					event: sampleEvent,
					photo_url: toImageDataUrl()
				})
			},
			true,
			bindings
		);
		const submitJson = await submit.json<{ submission_id: string }>();

		const deleteSingle = await callApp(
			`/events/delete_image?submission_id=${submitJson.submission_id}`,
			{ method: 'DELETE' },
			true,
			bindings
		);
		expect(deleteSingle.status).toBe(204);

		const deleteBulk = await callApp(
			'/events/delete_image?event_id=100000000000000000000555&user_id=777',
			{ method: 'DELETE' },
			true,
			bindings
		);
		expect(deleteBulk.status).toBe(204);
	});

	it('rejects invalid delete image query parameter combinations', async () => {
		const missingDeleteFilters = await callApp('/events/delete_image', { method: 'DELETE' });
		expect(missingDeleteFilters.status).toBe(400);

		const badDeleteSubmission = await callApp('/events/delete_image?submission_id=bad', {
			method: 'DELETE'
		});
		expect(badDeleteSubmission.status).toBe(400);

		const notFoundDelete = await callApp(
			'/events/delete_image?submission_id=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			{ method: 'DELETE' }
		);
		expect(notFoundDelete.status).toBe(404);

		const badDeleteEvent = await callApp('/events/delete_image?event_id=abc', {
			method: 'DELETE'
		});
		expect(badDeleteEvent.status).toBe(400);
	});
});

describe('POST /articles/quiz/create', () => {
	it('validates request body and normalizes true/false fallback answers', async () => {
		const missingArticle = await callApp('/articles/quiz/create', {
			method: 'POST',
			body: JSON.stringify({})
		});
		expect(missingArticle.status).toBe(400);

		const quizBindings = createMockBindings({
			AI: {
				run: vi.fn(async () => ({
					response: JSON.stringify({
						questions: [
							{
								question: 'Is water wet?',
								type: 'true_false',
								options: [],
								correct_answer_index: -1,
								is_true: false,
								is_false: false
							}
						]
					})
				}))
			} as any
		});

		const createdQuiz = await callApp(
			'/articles/quiz/create',
			{ method: 'POST', body: JSON.stringify({ article: sampleArticle }) },
			true,
			quizBindings
		);
		expect(createdQuiz.status).toBe(201);
		const json =
			await createdQuiz.json<Array<{ correct_answer_index: number; correct_answer: string }>>();
		expect(json[0]?.correct_answer_index).toBe(1);
		expect(json[0]?.correct_answer).toBe('False');
	});

	it('returns 422 when quiz generation returns no questions', async () => {
		const failedCreate = await callApp(
			'/articles/quiz/create',
			{ method: 'POST', body: JSON.stringify({ article: sampleArticle }) },
			true,
			createMockBindings({
				AI: {
					run: vi.fn(async () => ({ response: JSON.stringify({ questions: [] }) }))
				} as any
			})
		);
		expect(failedCreate.status).toBe(422);
	});
});

describe('GET /articles/quiz', () => {
	it('returns 400 when article id is missing', async () => {
		const response = await callApp('/articles/quiz', { method: 'GET' });
		expect(response.status).toBe(400);
	});

	it('returns 404 when quiz data does not exist', async () => {
		const response = await callApp('/articles/quiz?articleId=404', { method: 'GET' });
		expect(response.status).toBe(404);
	});

	it('normalizes quiz question options for true/false entries', async () => {
		const bindings = createMockBindings();
		await bindings.KV.put(
			'article:quiz:100',
			JSON.stringify([
				{
					question: 'T/F question',
					type: 'true_false',
					options: [],
					correct_answer_index: -1,
					is_true: true,
					is_false: false
				}
			])
		);

		const response = await callApp(
			'/articles/quiz?articleId=100',
			{ method: 'GET' },
			true,
			bindings
		);
		expect(response.status).toBe(200);
		const json = await response.json<Array<{ options: string[]; correct_answer_index: number }>>();
		expect(json[0]?.options).toEqual(['True', 'False']);
		expect(json[0]?.correct_answer_index).toBe(0);
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

	it('submits answers and rejects duplicate submissions for same user/article', async () => {
		const bindings = createMockBindings();
		await bindings.KV.put(
			'article:quiz:100',
			JSON.stringify([
				{
					question: 'T/F question',
					type: 'true_false',
					options: [],
					correct_answer_index: -1,
					is_true: true,
					is_false: false
				},
				{
					question: 'Multiple choice question',
					type: 'multiple_choice',
					options: ['A', 'B', 'C', 'D'],
					correct_answer_index: 2
				}
			])
		);

		const submit = await callApp(
			'/articles/quiz/submit',
			{
				method: 'POST',
				body: JSON.stringify({
					articleId: '100',
					articleTypes: ['HOME_IMPROVEMENT'],
					userId: '123',
					answers: [
						{ question: 'T/F question', text: 'True', index: 0 },
						{ question: 'Multiple choice question', text: 'C', index: 2 }
					]
				})
			},
			true,
			bindings
		);
		expect(submit.status).toBe(200);

		const duplicate = await callApp(
			'/articles/quiz/submit',
			{
				method: 'POST',
				body: JSON.stringify({
					articleId: '100',
					articleTypes: ['HOME_IMPROVEMENT'],
					userId: '123',
					answers: [{ question: 'T/F question', text: 'True', index: 0 }]
				})
			},
			true,
			bindings
		);
		expect(duplicate.status).toBe(409);
	});
});

describe('GET /articles/quiz/score', () => {
	it('returns 400 when ids are missing', async () => {
		const response = await callApp('/articles/quiz/score', { method: 'GET' });
		expect(response.status).toBe(400);
	});

	it('returns 404 when quiz score does not exist', async () => {
		const response = await callApp('/articles/quiz/score?userId=123&articleId=404', {
			method: 'GET'
		});
		expect(response.status).toBe(404);
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

	it('returns AI-backed grading data for valid article content', async () => {
		const bindings = createMockBindings({
			AI: {
				run: createMockAiRun()
			} as any
		});

		const response = await callApp(
			'/articles/grade',
			{
				method: 'POST',
				body: JSON.stringify({
					id: '100',
					content: 'A long article body about restoration systems.'
				})
			},
			true,
			bindings
		);
		expect(response.status).toBe(200);
	});
});

describe('content reports + strikes routes', () => {
	function reportBody(overrides: Record<string, unknown> = {}) {
		return JSON.stringify({
			content_type: 'prompt',
			content_id: 'c-1',
			reason: 'spam',
			reporter_id: '42',
			...overrides
		});
	}

	// the POST /reports handler kicks off background moderation that fetches content from mantle2;
	// stub fetch so it resolves to empty content and the request stays self-contained
	function stubModerationFetch() {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
	}

	describe('POST /reports', () => {
		it('creates a report and returns 201 with deduped flag', async () => {
			stubModerationFetch();
			const response = await callApp('/reports', { method: 'POST', body: reportBody() });
			expect(response.status).toBe(201);
			const json = (await response.json()) as { report: { status: string }; deduped: boolean };
			expect(json.deduped).toBe(false);
			expect(json.report.status).toBe('pending');
		});

		it('folds a duplicate report on the same content into the existing one', async () => {
			stubModerationFetch();
			const bindings = createMockBindings();
			await callApp('/reports', { method: 'POST', body: reportBody() }, true, bindings);
			const second = await callApp(
				'/reports',
				{ method: 'POST', body: reportBody() },
				true,
				bindings
			);
			const json = (await second.json()) as { deduped: boolean; report: { report_count: number } };
			expect(json.deduped).toBe(true);
			expect(json.report.report_count).toBe(2);
		});

		it('rejects an invalid content_type', async () => {
			const response = await callApp('/reports', {
				method: 'POST',
				body: reportBody({ content_type: 'comment' })
			});
			expect(response.status).toBe(400);
		});

		it('rejects a missing content_id', async () => {
			const response = await callApp('/reports', {
				method: 'POST',
				body: reportBody({ content_id: '' })
			});
			expect(response.status).toBe(400);
		});

		it('rejects an invalid reason', async () => {
			const response = await callApp('/reports', {
				method: 'POST',
				body: reportBody({ reason: 'nonsense' })
			});
			expect(response.status).toBe(400);
		});

		it('rejects an unparseable body', async () => {
			const response = await callApp('/reports', { method: 'POST', body: 'not json' });
			expect(response.status).toBe(400);
		});

		it('requires authentication', async () => {
			const response = await callApp('/reports', { method: 'POST', body: reportBody() }, false);
			expect(response.status).toBe(401);
		});
	});

	describe('GET /reports', () => {
		it('lists pending reports by default', async () => {
			stubModerationFetch();
			const bindings = createMockBindings();
			await callApp('/reports', { method: 'POST', body: reportBody() }, true, bindings);

			const response = await callApp('/reports', {}, true, bindings);
			expect(response.status).toBe(200);
			const json = (await response.json()) as { reports: unknown[] };
			expect(json.reports).toHaveLength(1);
		});

		it('rejects an invalid status filter', async () => {
			const response = await callApp('/reports?status=bogus');
			expect(response.status).toBe(400);
		});
	});

	describe('GET /reports/:id', () => {
		it('returns a stored report', async () => {
			stubModerationFetch();
			const bindings = createMockBindings();
			const created = await callApp(
				'/reports',
				{ method: 'POST', body: reportBody() },
				true,
				bindings
			);
			const { report } = (await created.json()) as { report: { id: string } };

			const response = await callApp(`/reports/${report.id}`, {}, true, bindings);
			expect(response.status).toBe(200);
		});

		it('returns 404 for a missing report', async () => {
			const response = await callApp('/reports/nope');
			expect(response.status).toBe(404);
		});
	});

	describe('PATCH /reports/:id', () => {
		it('updates a report status', async () => {
			stubModerationFetch();
			const bindings = createMockBindings();
			const created = await callApp(
				'/reports',
				{ method: 'POST', body: reportBody() },
				true,
				bindings
			);
			const { report } = (await created.json()) as { report: { id: string } };

			const response = await callApp(
				`/reports/${report.id}`,
				{ method: 'PATCH', body: JSON.stringify({ status: 'dismissed', reviewed_by: 'admin' }) },
				true,
				bindings
			);
			expect(response.status).toBe(200);
			const json = (await response.json()) as { status: string; reviewed_by: string };
			expect(json.status).toBe('dismissed');
			expect(json.reviewed_by).toBe('admin');
		});

		it('rejects an invalid status', async () => {
			const response = await callApp('/reports/x', {
				method: 'PATCH',
				body: JSON.stringify({ status: 'bogus' })
			});
			expect(response.status).toBe(400);
		});

		it('returns 404 for a missing report', async () => {
			const response = await callApp('/reports/nope', {
				method: 'PATCH',
				body: JSON.stringify({ status: 'dismissed' })
			});
			expect(response.status).toBe(404);
		});
	});

	describe('DELETE /reports/:id', () => {
		it('deletes a report and returns 204', async () => {
			stubModerationFetch();
			const bindings = createMockBindings();
			const created = await callApp(
				'/reports',
				{ method: 'POST', body: reportBody() },
				true,
				bindings
			);
			const { report } = (await created.json()) as { report: { id: string } };

			const response = await callApp(`/reports/${report.id}`, { method: 'DELETE' }, true, bindings);
			expect(response.status).toBe(204);
		});

		it('returns 404 for a missing report', async () => {
			const response = await callApp('/reports/nope', { method: 'DELETE' });
			expect(response.status).toBe(404);
		});
	});

	describe('user strikes routes', () => {
		it('returns a zeroed record for a user with no strikes', async () => {
			const response = await callApp('/users/42/strikes');
			expect(response.status).toBe(200);
			const json = (await response.json()) as { count: number; banned: boolean };
			expect(json.count).toBe(0);
			expect(json.banned).toBe(false);
		});

		it('adds a strike and returns the action', async () => {
			const response = await callApp('/users/42/strikes', {
				method: 'POST',
				body: JSON.stringify({ content_type: 'prompt', content_id: 'c-1', reason: 'spam' })
			});
			expect(response.status).toBe(200);
			const json = (await response.json()) as { strikes: { count: number }; action: string };
			expect(json.strikes.count).toBe(1);
			expect(json.action).toBe('none');
		});

		it('rejects an invalid reason when adding a strike', async () => {
			const response = await callApp('/users/42/strikes', {
				method: 'POST',
				body: JSON.stringify({ content_type: 'prompt', content_id: 'c-1', reason: 'bad' })
			});
			expect(response.status).toBe(400);
		});

		it('resets strikes for a user', async () => {
			const bindings = createMockBindings();
			await callApp(
				'/users/42/strikes',
				{
					method: 'POST',
					body: JSON.stringify({ content_type: 'prompt', content_id: 'c-1', reason: 'spam' })
				},
				true,
				bindings
			);

			const response = await callApp('/users/42/strikes/reset', { method: 'POST' }, true, bindings);
			expect(response.status).toBe(200);
			const json = (await response.json()) as { count: number };
			expect(json.count).toBe(0);
		});
	});

	// the id flip means a client holds the 32-hex event id, and r2 keys the thumbnail on the
	// numeric one; these routes used to reject the hex shape outright with a 400
	describe('event thumbnail routes accept either id shape', () => {
		const HEX = 'b1c2d3e4f506172839a4b5c6d7e8f901';

		it('resolves a public event id rather than rejecting it', async () => {
			const bindings = createMockBindings();
			await bindings.KV.put(`event:alias:${HEX}`, '44');

			const response = await callApp(`/events/thumbnail/${HEX}`, {}, true, bindings);

			// 404 means it resolved and found no thumbnail; 400 would mean it refused the shape
			expect(response.status).toBe(404);
		});

		it('still rejects a shape that is neither', async () => {
			const response = await callApp('/events/thumbnail/not-an-id');
			expect(response.status).toBe(400);
		});

		it('accepts the numeric id with no lookup', async () => {
			const response = await callApp('/events/thumbnail/44');
			expect(response.status).toBe(404);
		});
	});
});
