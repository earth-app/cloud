import { afterEach, describe, expect, it, vi } from 'vitest';
import {
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
});

describe('findArticle', () => {
	it('is exported as a function', () => {
		expect(typeof findArticle).toBe('function');
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
});

describe('recommendSimilarArticles', () => {
	it('throws when pool is empty', async () => {
		const ai = { run: vi.fn() } as any;
		await expect(recommendSimilarArticles({} as Article, [], 3, ai)).rejects.toThrow();
	});
});

describe('createPrompt', () => {
	it('throws when ai output is empty', async () => {
		const ai = { run: vi.fn(async () => ({ output: [] })) } as any;
		await expect(createPrompt(ai)).rejects.toThrow('Failed to generate prompt');
	});
});

describe('postPrompt', () => {
	it('throws for short prompts', async () => {
		await expect(postPrompt('short', createBindings())).rejects.toThrow(
			'Prompt must be at least 10 characters long'
		);
	});
});

describe('retrieveActivities', () => {
	it('returns empty list when first fetch fails', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('bad', { status: 500 }));
		const result = await retrieveActivities(createBindings());
		expect(result).toEqual([]);
	});
});

describe('rankActivitiesForEvent', () => {
	it('returns empty list for empty pool', async () => {
		const ai = { run: vi.fn() } as any;
		const result = await rankActivitiesForEvent('Event', 'Desc', [], ai, 2);
		expect(result).toEqual([]);
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
});

describe('recommendEvents', () => {
	it('throws when pool or activities are missing', async () => {
		const ai = { run: vi.fn() } as any;
		await expect(recommendEvents([], ['NATURE'], 3, ai)).rejects.toThrow();
		await expect(recommendEvents([{} as Event], [], 3, ai)).rejects.toThrow();
	});
});

describe('recommendSimilarEvents', () => {
	it('throws when pool is empty', async () => {
		const ai = { run: vi.fn() } as any;
		await expect(recommendSimilarEvents({} as Event, [], 2, ai)).rejects.toThrow();
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
});
