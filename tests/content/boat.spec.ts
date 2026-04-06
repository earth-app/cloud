import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	articleTopicModel,
	createActivityData,
	createArticle,
	createArticleQuiz,
	createEvent,
	createPrompt,
	findArticle,
	findArticles,
	postActivity,
	postArticle,
	postEvent,
	postPrompt,
	rankActivitiesForEvent,
	rankerModel,
	recommendArticles,
	recommendEvents,
	recommendSimilarArticles,
	recommendSimilarEvents,
	retrieveActivities,
	retrieveEvents,
	type ArticleQuizQuestion
} from '../../src/content/boat';
import { ExactDateWithYearEntry } from '@earth-app/moho';
import { env } from 'cloudflare:workers';
import { MockKVNamespace } from '../helpers/mock-kv';
import {
	type Activity,
	type Article,
	type Bindings,
	type Event,
	type OceanArticle
} from '../../src/util/types';

afterEach(() => {
	vi.restoreAllMocks();
});

function createBindings(overrides: Partial<Bindings> = {}): Bindings {
	return {
		...env,
		ADMIN_API_KEY: 'test-admin',
		MANTLE_URL: 'https://api.test.earth-app.com',
		NCBI_API_KEY: 'ncbi',
		...overrides
	} as Bindings;
}

function makeArticle(id: string, title: string): Article {
	return {
		id,
		title,
		description: `${title} description`,
		tags: ['NATURE'],
		content: `${title} content`.repeat(8),
		author: {},
		author_id: '1',
		color: '#ffffff',
		color_hex: '#ffffff',
		created_at: new Date().toISOString(),
		ocean: {
			title,
			author: 'Author',
			source: 'Source',
			url: `https://example.com/${id}`,
			keywords: ['ocean'],
			date: '2026-01-01',
			links: {}
		}
	};
}

function makeEvent(id: string, name: string): Event {
	return {
		id,
		name,
		description: `${name} description`,
		type: 'ONLINE',
		date: Date.now(),
		end_date: Date.now() + 60_000,
		visibility: 'PUBLIC',
		activities: [{ type: 'activity_type', value: 'NATURE' }],
		fields: {}
	};
}

describe('createActivityData', () => {
	it('throws when description generation repeatedly fails', async () => {
		const ai = {
			run: vi.fn(async () => {
				throw new Error('model down');
			})
		} as any;

		await expect(createActivityData('gardening', 'gardening', ai)).rejects.toThrow(
			'Activity data creation failed'
		);
	});

	it('creates activity data with aliases and icon when model outputs are valid', async () => {
		vi.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(
				new Response(JSON.stringify([{ word: 'gardening', meanings: [] }]), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify([
						{
							word: 'gardening',
							meanings: [
								{
									definitions: [
										{
											synonyms: ['horticulture', 'green thumb', 'planting']
										}
									],
									synonyms: ['cultivation']
								}
							]
						}
					]),
					{ status: 200, headers: { 'Content-Type': 'application/json' } }
				)
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						total: 2,
						icons: ['mdi:leaf', 'ph:plant-rounded']
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } }
				)
			);

		const longDescription =
			'Gardening is a practical activity that combines observation, patience, and hands-on learning in natural spaces. '.repeat(
				4
			) + 'It helps communities build healthier environments while learning about plants.';

		const ai = {
			run: vi.fn(async (model: string) => {
				if (model.includes('llama-4-scout')) {
					return { response: longDescription };
				}
				if (model.includes('llama-3.1-8b-instruct-fp8')) {
					return { response: 'NATURE,TECHNOLOGY' };
				}
				return {};
			})
		} as any;

		const result = await createActivityData('urban_gardening', 'gardening', ai);
		expect(result.id).toBe('urban_gardening');
		expect(result.description.length).toBeGreaterThan(200);
		expect(result.aliases).toContain('horticulture');
		expect(result.aliases).toContain('cultivation');
		expect(result.fields.icon).toBe('ph:plant-rounded');
	});
});

describe('postActivity', () => {
	it('throws when upstream returns non-ok response', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('bad', { status: 500 }));

		await expect(
			postActivity(createBindings(), {
				id: '1',
				name: 'Gardening',
				description: 'desc',
				aliases: [],
				types: ['NATURE'],
				fields: {}
			} as Activity)
		).rejects.toThrow('Failed to post activity');
	});

	it('throws when created activity payload has no id', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(JSON.stringify({ name: 'Gardening' }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			})
		);

		await expect(
			postActivity(createBindings(), {
				id: '1',
				name: 'Gardening',
				description: 'desc',
				aliases: [],
				types: ['NATURE'],
				fields: {}
			} as Activity)
		).rejects.toThrow('Failed to create activity, no ID returned');
	});
});

describe('findArticle', () => {
	it('is exported as a function', () => {
		expect(typeof findArticle).toBe('function');
	});

	it('throws when topic generation model fails', async () => {
		const bindings = createBindings({
			AI: {
				run: vi.fn(async () => {
					throw new Error('topic model down');
				})
			} as any
		});

		await expect(findArticle(bindings)).rejects.toThrow(
			'Failed to generate article topic using AI model'
		);
	});

	it('throws when no topic is generated', async () => {
		const bindings = createBindings({
			AI: {
				run: vi.fn(async () => ({ response: '' }))
			} as any
		});

		await expect(findArticle(bindings)).rejects.toThrow('Failed to generate valid article topic');
	});

	it('returns an article when topic generation succeeds', async () => {
		const bindings = createBindings({
			AI: {
				run: vi.fn(async (model: string) => {
					if (model.includes(rankerModel)) {
						return { response: [{ id: 0, score: 0.9 }] };
					}

					if (model.includes(articleTopicModel)) {
						return { response: 'Climate Change' };
					}

					throw new Error('Unexpected model called: ' + model);
				})
			} as any
		});

		const result = await findArticle(bindings);
		expect(result.length).toBe(2);
		expect(result[0].length).toBeGreaterThan(1);
		expect(result[0][0].title).toBeDefined();
		expect(result[1].length).toBeGreaterThan(1);
		expect(result[1][0]).toBeDefined();
	});
});

describe('findArticles', () => {
	it('is exported as a function', () => {
		expect(typeof findArticles).toBe('function');
	});
});

describe('createArticle', () => {
	it('throws when no source content is available', async () => {
		const ai = { run: vi.fn() } as any;
		await expect(
			createArticle(
				{
					title: 'T',
					author: 'A',
					source: 'S',
					url: 'https://example.com/ocean',
					keywords: [],
					date: '2026-01-01',
					links: {}
				} as OceanArticle,
				ai,
				['SCIENCE']
			)
		).rejects.toThrow('No content available for article generation');
	});

	it('creates an article when title and summary generation succeed', async () => {
		const ai = {
			run: vi
				.fn()
				.mockResolvedValueOnce({ response: 'Climate Resilience Through Local Action' })
				.mockResolvedValueOnce({
					response:
						'Sustainable neighborhoods depend on practical planning, resilient design, and inclusive decision-making. '.repeat(
							8
						) +
						'Communities can reduce environmental harm while strengthening quality of life through measurable local initiatives.'
				})
		} as any;

		const ocean: OceanArticle = {
			title: 'Original Source Title',
			author: 'Author',
			source: 'Source',
			url: 'https://example.com/ocean/article',
			keywords: ['climate'],
			date: '2026-01-01',
			links: {},
			content: 'source content '.repeat(50)
		};

		const result = await createArticle(ocean, ai, ['NATURE']);
		expect(result.title).toBe('Climate Resilience Through Local Action');
		expect(result.description.length).toBeGreaterThan(40);
		expect(result.content.length).toBeGreaterThan(300);
	});

	it('wraps title and summary model failures with article creation errors', async () => {
		const titleFailAi = {
			run: vi.fn(async () => {
				throw new Error('title failed');
			})
		} as any;

		await expect(
			createArticle(
				{
					title: 'Original Source Title',
					author: 'Author',
					source: 'Source',
					url: 'https://example.com/ocean/article',
					keywords: ['climate'],
					date: '2026-01-01',
					links: {},
					content: 'source content '.repeat(50)
				} as OceanArticle,
				titleFailAi,
				['NATURE']
			)
		).rejects.toThrow('Article creation failed: Failed to generate article title using AI model');

		const summaryFailAi = {
			run: vi
				.fn()
				.mockResolvedValueOnce({ response: 'Solid Climate Planning Guide' })
				.mockRejectedValueOnce(new Error('summary failed'))
		} as any;

		await expect(
			createArticle(
				{
					title: 'Original Source Title',
					author: 'Author',
					source: 'Source',
					url: 'https://example.com/ocean/article',
					keywords: ['climate'],
					date: '2026-01-01',
					links: {},
					content: 'source content '.repeat(50)
				} as OceanArticle,
				summaryFailAi,
				['NATURE']
			)
		).rejects.toThrow('Article creation failed: Failed to generate article summary using AI model');
	});
});

describe('createArticleQuiz', () => {
	it('returns empty array on generation failure', async () => {
		const ai = {
			run: vi.fn(async () => {
				throw new Error('nope');
			})
		} as any;
		const result = await createArticleQuiz(
			{
				title: 'Title',
				content: 'Body',
				tags: [],
				ocean: {
					title: 'Title',
					author: 'Author',
					source: 'Source',
					url: 'https://example.com/ocean',
					keywords: [],
					date: '2026-01-01',
					links: {}
				}
			},
			ai
		);
		expect(result).toEqual([]);
	});

	it('returns parsed questions from fenced json', async () => {
		const questions: ArticleQuizQuestion[] = [
			{
				question: 'Q1',
				type: 'multiple_choice',
				options: ['A', 'B', 'C', 'D'],
				correct_answer: 'A',
				correct_answer_index: 0
			}
		];
		const ai = {
			run: vi.fn(async () => ({ response: `\`\`\`json\n${JSON.stringify({ questions })}\n\`\`\`` }))
		} as any;

		const result = await createArticleQuiz(
			{
				title: 'Title',
				content: 'Body',
				tags: [],
				ocean: {
					title: 'Title',
					author: 'Author',
					source: 'Source',
					url: 'https://example.com/ocean',
					keywords: [],
					date: '2026-01-01',
					links: {}
				}
			},
			ai
		);

		expect(result).toHaveLength(1);
		expect(result[0].question).toBe('Q1');
	});
});

describe('postArticle', () => {
	it('throws when article post fails', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('bad', { status: 500 }));
		await expect(
			postArticle(
				{
					title: 'T',
					description: 'D',
					content: 'C',
					ocean: {
						title: 'T',
						author: 'A',
						source: 'S',
						url: 'https://example.com/ocean',
						keywords: [],
						date: '2026-01-01',
						links: {}
					}
				},
				null,
				createBindings()
			)
		).rejects.toThrow('Failed to post article');
	});
});

describe('recommendArticles', () => {
	it('throws when pool or activities are missing', async () => {
		const ai = { run: vi.fn() } as any;
		await expect(recommendArticles([], ['hiking'], 5, ai)).rejects.toThrow();
		await expect(recommendArticles([{} as Article], [], 5, ai)).rejects.toThrow();
	});

	it('returns top-ranked article results when reranker responds', async () => {
		const pool = [makeArticle('a1', 'First'), makeArticle('a2', 'Second')];
		const ai = {
			run: vi.fn(async () => ({
				response: [
					{ id: 0, score: 0.31 },
					{ id: 1, score: 0.88 }
				]
			}))
		} as any;

		const result = await recommendArticles(pool, ['nature'], 1, ai);
		expect(result).toHaveLength(1);
		expect(result[0]?.id).toBe('a2');
	});

	it('falls back to random output when reranker response is missing', async () => {
		const pool = [makeArticle('only', 'Only')];
		const ai = { run: vi.fn(async () => ({})) } as any;
		const result = await recommendArticles(pool, ['nature'], 1, ai);
		expect(result).toEqual(pool);
	});
});

describe('recommendSimilarArticles', () => {
	it('throws when pool is empty', async () => {
		const ai = { run: vi.fn() } as any;
		await expect(recommendSimilarArticles({} as Article, [], 3, ai)).rejects.toThrow();
	});

	it('excludes the original article and relaxes threshold when needed', async () => {
		const original = makeArticle('a1', 'Original');
		const candidate = makeArticle('a2', 'Candidate');
		const ai = {
			run: vi.fn(async () => ({
				response: [
					{ id: 0, score: 0.95 },
					{ id: 1, score: 0.2 }
				]
			}))
		} as any;

		const result = await recommendSimilarArticles(original, [original, candidate], 2, ai);
		expect(result).toHaveLength(1);
		expect(result[0]?.id).toBe('a2');
	});
});

describe('createPrompt', () => {
	it('throws when ai output is empty', async () => {
		const ai = { run: vi.fn(async () => ({ output: [] })) } as any;
		await expect(createPrompt(ai)).rejects.toThrow('Failed to generate prompt');
	});

	it('throws when output has no message entry', async () => {
		const ai = {
			run: vi.fn(async () => ({ output: [{ id: 'reason', type: 'reasoning', content: [] }] }))
		} as any;
		await expect(createPrompt(ai)).rejects.toThrow('No valid prompt message found in response');
	});
});

describe('postPrompt', () => {
	it('throws for short prompts', async () => {
		await expect(postPrompt('short', createBindings())).rejects.toThrow(
			'Prompt must be at least 10 characters long'
		);
	});

	it('throws when prompt creation response has no id', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(JSON.stringify({ prompt: 'No ID' }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			})
		);

		await expect(
			postPrompt('How does urban farming improve resilience?', createBindings())
		).rejects.toThrow('Failed to create prompt, no ID returned');
	});

	it('posts valid prompts successfully', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					id: 'prompt-1',
					owner_id: '42',
					prompt: 'How can communities restore coastal reefs sustainably?',
					visibility: 'PUBLIC',
					created_at: new Date().toISOString()
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } }
			)
		);

		const result = await postPrompt(
			'How can communities restore coastal reefs sustainably?',
			createBindings()
		);
		expect(result.id).toBe('prompt-1');
	});
});

describe('retrieveActivities', () => {
	it('returns empty list when first fetch fails', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('bad', { status: 500 }));
		const result = await retrieveActivities(createBindings());
		expect(result).toEqual([]);
	});

	it('returns first page results when a later page fetch fails', async () => {
		vi.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						items: [
							{
								id: 'a1',
								name: 'First Activity',
								types: ['NATURE'],
								description: 'desc',
								aliases: [],
								fields: {}
							}
						],
						total: 201,
						page: 1
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } }
				)
			)
			.mockResolvedValueOnce(new Response('page failed', { status: 500 }));

		const result = await retrieveActivities(createBindings());
		expect(result).toHaveLength(1);
		expect(result[0]?.id).toBe('a1');
	});

	it('fetches additional pages when total exceeds first page', async () => {
		vi.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						items: [
							{
								id: 'a1',
								name: 'First Activity',
								types: ['NATURE'],
								description: 'desc',
								aliases: [],
								fields: {}
							}
						],
						total: 101,
						page: 1
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } }
				)
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						items: [
							{
								id: 'a2',
								name: 'Second Activity',
								types: ['ART'],
								description: 'desc2',
								aliases: [],
								fields: {}
							}
						]
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } }
				)
			);

		const result = await retrieveActivities(createBindings());
		expect(result.map((a) => a.id)).toEqual(['a1', 'a2']);
	});
});

describe('rankActivitiesForEvent', () => {
	it('returns empty list for empty pool', async () => {
		const ai = { run: vi.fn() } as any;
		const result = await rankActivitiesForEvent('Event', 'Desc', [], ai, 2);
		expect(result).toEqual([]);
	});

	it('returns empty list when ranking response is missing', async () => {
		const ai = { run: vi.fn(async () => ({})) } as any;
		const result = await rankActivitiesForEvent(
			'City Cleanup',
			'Local volunteers restoring parks.',
			[{ id: 'cleanup', name: 'Cleanup', description: 'desc', fields: {} } as any],
			ai,
			2
		);
		expect(result).toEqual([]);
	});

	it('returns high-confidence activity IDs from ranking output', async () => {
		const activities = [
			{ id: 'hiking', name: 'Hiking', description: 'Mountain trail', fields: {} },
			{ id: 'cooking', name: 'Cooking', description: 'Kitchen skills', fields: {} }
		] as any[];
		const ai = {
			run: vi.fn(async () => ({
				response: [
					{ id: 0, score: 0.95 },
					{ id: 1, score: 0.4 }
				]
			}))
		} as any;

		const result = await rankActivitiesForEvent(
			'Forest Meetup',
			'Trail and wildlife',
			activities,
			ai,
			2
		);
		expect(result).toEqual(['hiking']);
	});
});

describe('retrieveEvents', () => {
	it('returns a list of upcoming calendar entries', () => {
		expect(Array.isArray(retrieveEvents())).toBe(true);
	});
});

describe('createEvent', () => {
	it('returns null when event entry has no name', async () => {
		const result = await createEvent({ name: '' } as any, new Date(), createBindings());
		expect(result).toBeNull();
	});

	it('returns null when source month/day is invalid (prevents Date rollover events)', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch');
		const result = await createEvent(
			new ExactDateWithYearEntry(
				"Raleigh (NC)'s Birthday",
				11,
				31,
				1792,
				'birthdays/us/cities.csv'
			),
			new Date('2026-11-30T00:00:00.000Z'),
			createBindings()
		);

		expect(result).toBeNull();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('allows leap-day birthday rows to pass source validation', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(JSON.stringify({ total: 1 }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			})
		);

		const result = await createEvent(
			new ExactDateWithYearEntry("Worcester's Birthday", 2, 29, 1848, 'birthdays/us/cities.csv'),
			new Date('2026-03-01T00:00:00.000Z'),
			createBindings()
		);

		expect(result).toBeNull();
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it('preserves trailing-apostrophe possessive style in generated ordinal names', async () => {
		vi.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ total: 0 }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ items: [], total: 0, page: 1 }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			);

		const result = await createEvent(
			new ExactDateWithYearEntry("Bahamas' Birthday", 7, 10, 1973, 'birthdays/countries.csv'),
			new Date('2026-07-10T00:00:00.000Z'),
			createBindings({
				AI: {
					run: vi.fn(async () => ({}))
				} as any
			})
		);

		expect(result).not.toBeNull();
		expect(result?.name).toMatch(/Bahamas' \d+(st|nd|rd|th) Birthday/);
	});

	it('returns null when computed date is invalid', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch');
		const result = await createEvent(
			new ExactDateWithYearEntry("Afghanistan's Birthday", 8, 19, 1919, 'birthdays/countries.csv'),
			new Date('invalid-date'),
			createBindings()
		);

		expect(result).toBeNull();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('continues event creation when existence lookup fails upstream', async () => {
		vi.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(new Response('search failed', { status: 500 }))
			.mockResolvedValueOnce(new Response('activities failed', { status: 500 }));

		const ai = {
			run: vi.fn(async (model: string) => {
				if (model.includes('llama-4-scout')) {
					return {
						response:
							'A global community celebration that highlights culture, identity, and civic participation through educational storytelling and events. '.repeat(
								3
							) + 'It encourages reflection, participation, and shared memory.'
					};
				}
				return { response: 'NATURE,ART' };
			})
		} as any;

		const event = await createEvent(
			new ExactDateWithYearEntry("Bahamas' Birthday", 7, 10, 1973, 'birthdays/countries.csv'),
			new Date('2026-07-10T00:00:00.000Z'),
			createBindings({ AI: ai })
		);

		expect(event).not.toBeNull();
		expect(event?.activities.length).toBeGreaterThan(0);
	});

	it('throws when event description generation fails', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(JSON.stringify({ total: 0 }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			})
		);

		const ai = {
			run: vi.fn(async () => {
				throw new Error('description model down');
			})
		} as any;

		await expect(
			createEvent(
				new ExactDateWithYearEntry("Bahamas' Birthday", 7, 10, 1973, 'birthdays/countries.csv'),
				new Date('2026-07-10T00:00:00.000Z'),
				createBindings({ AI: ai })
			)
		).rejects.toThrow('Failed to generate event description using AI model');
	});

	it('falls back to OTHER tags when activity-tag generation fails', async () => {
		vi.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ total: 0 }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			)
			.mockResolvedValueOnce(new Response('activities failed', { status: 500 }));

		const ai = {
			run: vi.fn(async (model: string) => {
				if (model.includes('llama-4-scout')) {
					return {
						response:
							'An annual celebration that honors shared history, community values, and cultural storytelling in public spaces. '.repeat(
								3
							) + 'The event encourages learning, participation, and collective pride.'
					};
				}
				throw new Error('tags model down');
			})
		} as any;

		const event = await createEvent(
			new ExactDateWithYearEntry("Bahamas' Birthday", 7, 10, 1973, 'birthdays/countries.csv'),
			new Date('2026-07-10T00:00:00.000Z'),
			createBindings({ AI: ai })
		);

		expect(event).not.toBeNull();
		expect(event?.activities.includes('OTHER')).toBe(true);
	});
});

describe('recommendEvents', () => {
	it('throws when pool or activities are missing', async () => {
		const ai = { run: vi.fn() } as any;
		await expect(recommendEvents([], ['NATURE'], 3, ai)).rejects.toThrow();
		await expect(recommendEvents([{} as Event], [], 3, ai)).rejects.toThrow();
	});

	it('returns top-ranked events when reranker responds', async () => {
		const e1 = makeEvent('e1', 'City Cleanup');
		const e2 = makeEvent('e2', 'Beach Walk');
		const ai = {
			run: vi.fn(async () => ({
				response: [
					{ id: 0, score: 0.2 },
					{ id: 1, score: 0.9 }
				]
			}))
		} as any;

		const result = await recommendEvents([e1, e2], ['NATURE'], 1, ai);
		expect(result).toHaveLength(1);
		expect(result[0]?.id).toBe('e2');
	});

	it('falls back to random output when reranker fails or returns no response', async () => {
		const pool = [makeEvent('e1', 'City Cleanup')];

		const missingResponse = await recommendEvents(pool, ['NATURE'], 1, {
			run: vi.fn(async () => ({}))
		} as any);
		expect(missingResponse).toEqual(pool);

		const thrown = await recommendEvents(pool, ['NATURE'], 1, {
			run: vi.fn(async () => {
				throw new Error('ranking failed');
			})
		} as any);
		expect(thrown).toEqual(pool);
	});
});

describe('recommendSimilarEvents', () => {
	it('throws when pool is empty', async () => {
		const ai = { run: vi.fn() } as any;
		await expect(recommendSimilarEvents({} as Event, [], 2, ai)).rejects.toThrow();
	});

	it('excludes original event in similarity recommendations', async () => {
		const original = makeEvent('e1', 'Original Event');
		const candidate = makeEvent('e2', 'Candidate Event');
		const ai = {
			run: vi.fn(async () => ({
				response: [
					{ id: 0, score: 0.99 },
					{ id: 1, score: 0.65 }
				]
			}))
		} as any;

		const result = await recommendSimilarEvents(original, [original, candidate], 2, ai);
		expect(result).toHaveLength(1);
		expect(result[0]?.id).toBe('e2');
	});

	it('falls back to random output when similarity ranking fails', async () => {
		const original = makeEvent('e1', 'Original Event');
		const candidate = makeEvent('e2', 'Candidate Event');

		const noResponse = await recommendSimilarEvents(original, [original, candidate], 2, {
			run: vi.fn(async () => ({}))
		} as any);
		expect(noResponse).toEqual([candidate]);

		const thrown = await recommendSimilarEvents(original, [original, candidate], 2, {
			run: vi.fn(async () => {
				throw new Error('ranking failed');
			})
		} as any);
		expect(thrown).toEqual([candidate]);
	});
});

describe('createPrompt', () => {
	it('returns validated prompt text from model response output', async () => {
		const ai = {
			run: vi.fn(async () => ({
				output: [
					{
						id: 'msg',
						type: 'message',
						content: [
							{
								type: 'output_text',
								text: 'How can coastal cities reduce flood risk while restoring habitats?'
							}
						]
					}
				]
			}))
		} as any;

		const result = await createPrompt(ai);
		expect(result).toBe('How can coastal cities reduce flood risk while restoring habitats?');
	});
});

describe('postActivity', () => {
	it('returns created activity payload on success', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					id: 'act-1',
					name: 'Gardening',
					types: ['NATURE'],
					description: 'desc',
					aliases: [],
					fields: {}
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } }
			)
		);

		const result = await postActivity(createBindings(), {
			id: 'act-1',
			name: 'Gardening',
			types: ['NATURE'],
			description: 'desc',
			aliases: [],
			fields: {}
		} as any);

		expect(result.id).toBe('act-1');
	});
});

describe('postArticle', () => {
	it('stores quiz in KV when article creation succeeds', async () => {
		const kv = new MockKVNamespace();
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					id: 'article-123',
					title: 'Saved',
					description: 'Saved description',
					content: 'Saved content',
					tags: ['NATURE'],
					author: {},
					author_id: '1',
					color: '#ffffff',
					color_hex: '#ffffff',
					created_at: new Date().toISOString(),
					ocean: {
						title: 'Ocean',
						author: 'Author',
						source: 'Source',
						url: 'https://example.com/ocean',
						keywords: [],
						date: '2026-01-01',
						links: {}
					}
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } }
			)
		);

		const quiz: ArticleQuizQuestion[] = [
			{
				question: 'Q',
				type: 'multiple_choice',
				options: ['A', 'B', 'C', 'D'],
				correct_answer: 'A',
				correct_answer_index: 0
			}
		];

		const result = await postArticle(
			{
				title: 'Ocean Story',
				description: 'desc',
				content: 'content',
				ocean: {
					title: 'Ocean',
					author: 'Author',
					source: 'Source',
					url: 'https://example.com/ocean',
					keywords: [],
					date: '2026-01-01',
					links: {}
				}
			},
			quiz,
			createBindings({ KV: kv as any })
		);

		expect(result.id).toBe('article-123');
		const storedQuiz = await kv.get<ArticleQuizQuestion[]>('article:quiz:article-123', 'json');
		expect(storedQuiz).toEqual(quiz);
	});
});

describe('postEvent', () => {
	it('throws for null event payload', async () => {
		await expect(postEvent(null, createBindings(), { waitUntil: () => {} })).rejects.toThrow(
			'No event data to post'
		);
	});

	it('throws when required event fields are missing', async () => {
		await expect(
			postEvent(
				{
					name: '',
					description: '',
					activities: [],
					fields: {},
					type: 'ONLINE',
					date: Date.now(),
					visibility: 'PUBLIC'
				} as any,
				createBindings(),
				{ waitUntil: () => {} }
			)
		).rejects.toThrow('Event must have name and description');
	});

	it('throws when event creation response cannot be parsed as JSON', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response('not-json', {
				status: 200,
				headers: { 'Content-Type': 'text/plain' }
			})
		);

		await expect(
			postEvent(
				{
					name: "Bahamas' Birthday",
					description: 'A valid description.',
					activities: [],
					fields: {},
					type: 'ONLINE',
					date: Date.now(),
					visibility: 'PUBLIC'
				} as any,
				createBindings(),
				{ waitUntil: () => {} }
			)
		).rejects.toThrow('Failed to parse event creation response');
	});

	it('throws when event post request is non-successful', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('bad', { status: 500 }));

		await expect(
			postEvent(
				{
					name: 'Regular Meetup',
					description: 'A valid description.',
					activities: [],
					fields: {},
					type: 'ONLINE',
					date: Date.now(),
					visibility: 'PUBLIC'
				} as any,
				createBindings(),
				{ waitUntil: () => {} }
			)
		).rejects.toThrow('Failed to post event');
	});

	it('throws when event creation succeeds but response contains no id', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(JSON.stringify({ name: 'Regular Meetup' }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			})
		);

		await expect(
			postEvent(
				{
					name: 'Regular Meetup',
					description: 'A valid description.',
					activities: [],
					fields: {},
					type: 'ONLINE',
					date: Date.now(),
					visibility: 'PUBLIC'
				} as any,
				createBindings(),
				{ waitUntil: () => {} }
			)
		).rejects.toThrow('Failed to create event, no ID returned');
	});

	it('skips thumbnail generation when created event id is non-numeric', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(JSON.stringify({ id: 'event-abc', name: "Bahamas' Birthday" }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			})
		);

		const data = await postEvent(
			{
				name: "Bahamas' Birthday",
				description: 'A valid description.',
				activities: [],
				fields: {},
				type: 'ONLINE',
				date: Date.now(),
				visibility: 'PUBLIC'
			} as any,
			createBindings(),
			{ waitUntil: () => {} }
		);

		expect(data.id).toBe('event-abc');
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it('continues successfully when birthday thumbnail lookup fails', async () => {
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ id: '44', name: "Bahamas' Birthday" }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			)
			.mockResolvedValueOnce(new Response('maps-down', { status: 500 }));

		const data = await postEvent(
			{
				name: "Bahamas' Birthday",
				description: 'A valid description.',
				activities: [],
				fields: {},
				type: 'ONLINE',
				date: Date.now(),
				visibility: 'PUBLIC'
			} as any,
			createBindings({ MAPS_API_KEY: 'test-maps-key' } as Partial<Bindings>),
			{ waitUntil: () => {} }
		);

		expect(data.id).toBe('44');
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	it('skips thumbnail generation for non-birthday events with numeric ids', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(JSON.stringify({ id: '45', name: 'Regular Meetup' }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			})
		);

		const data = await postEvent(
			{
				name: 'Regular Meetup',
				description: 'A valid description.',
				activities: [],
				fields: {},
				type: 'ONLINE',
				date: Date.now(),
				visibility: 'PUBLIC'
			} as any,
			createBindings(),
			{ waitUntil: () => {} }
		);

		expect(data.id).toBe('45');
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});
});
