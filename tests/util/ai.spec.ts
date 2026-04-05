import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	activityDescriptionPrompt,
	activityDescriptionSystemMessage,
	articleClassificationQuery,
	articleCriteria,
	articleRecommendationQuery,
	articleSimilarityQuery,
	articleSummaryPrompt,
	articleTitlePrompt,
	articleTopicPrompt,
	articleTopicSystemMessage,
	eventActivitySelectionQuery,
	eventDescriptionPrompt,
	eventDescriptionSystemMessage,
	eventImageCaptionPrompt,
	eventImageCriteria,
	eventRecommendationQuery,
	eventSimilarityQuery,
	generateProfilePhoto,
	logAIFailure,
	promptCriteria,
	promptsQuestionPrompt,
	promptsSystemMessage,
	sanitizeAIOutput,
	sanitizeForContentType,
	userProfilePhotoPrompt,
	validateActivityDescription,
	validateActivityTags,
	validateArticleSummary,
	validateArticleTitle,
	validateArticleTopic,
	validateEventDescription,
	validatePromptQuestion
} from '../../src/util/ai';
import { type Article, type Event } from '../../src/util/types';

afterEach(() => {
	vi.restoreAllMocks();
});

describe('logAIFailure', () => {
	it('logs validation failures without throwing', () => {
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		expect(() => logAIFailure('ctx', 'in', 'out', 'err')).not.toThrow();
		expect(spy).toHaveBeenCalled();
	});
});

describe('sanitizeAIOutput', () => {
	it('removes markdown artifacts and leading wrappers', () => {
		const input = '```md\n**Title:** Here is the answer: [Link](https://x.com)\n```';
		expect(sanitizeAIOutput(input)).toBe('');
	});

	it('returns empty string for non-string input', () => {
		expect(sanitizeAIOutput('' as string)).toBe('');
	});
});

describe('sanitizeForContentType', () => {
	it('normalizes question punctuation', () => {
		expect(sanitizeForContentType('How does this work', 'question').endsWith('?')).toBe(true);
	});
});

describe('validateActivityDescription', () => {
	it('returns fallback when invalid and throwOnFailure=false', () => {
		const result = validateActivityDescription('short', 'gardening', false);
		expect(result.toLowerCase()).toContain('gardening');
	});
});

describe('validateActivityTags', () => {
	it('filters to known tags and falls back to OTHER', () => {
		expect(validateActivityTags('UNKNOWN_TAG', 'test')).toEqual(['OTHER']);
	});
});

describe('validateArticleTopic', () => {
	it('returns normalized topic', () => {
		expect(validateArticleTopic('Ocean Health')).toBe('ocean health');
	});
});

describe('validateArticleTitle', () => {
	it('rejects malformed title options', () => {
		expect(() => validateArticleTitle('A or B', 'Original')).toThrow();
	});
});

describe('validateArticleSummary', () => {
	it('accepts long summaries', () => {
		const summary = `${'word '.repeat(120)}${'x'.repeat(500)}.`;
		expect(validateArticleSummary(summary, 'Title').length).toBeGreaterThan(400);
	});
});

describe('validatePromptQuestion', () => {
	it('rejects prohibited phrasing', () => {
		expect(() => validatePromptQuestion('What if your world changed?')).toThrow();
	});
});

describe('validateEventDescription', () => {
	it('returns fallback when invalid and throwOnFailure=false', () => {
		const result = validateEventDescription('tiny', 'Earth Day', false);
		expect(result).toContain('Earth Day');
	});
});

describe('activityDescriptionSystemMessage', () => {
	it('contains output constraints', () => {
		expect(activityDescriptionSystemMessage).toContain('OUTPUT FORMAT');
	});
});

describe('activityDescriptionPrompt', () => {
	it('includes activity name in prompt', () => {
		expect(activityDescriptionPrompt('hiking')).toContain('hiking');
	});
});

describe('articleTopicSystemMessage', () => {
	it('defines topic generation constraints', () => {
		expect(articleTopicSystemMessage).toContain('1-3 words');
	});
});

describe('articleTopicPrompt', () => {
	it('returns non-empty example topic', () => {
		expect(articleTopicPrompt().length).toBeGreaterThan(0);
	});
});

describe('articleClassificationQuery', () => {
	it('formats topic + tag query text', () => {
		expect(articleClassificationQuery('climate', ['SCIENCE'])).toContain('climate');
	});
});

describe('articleTitlePrompt', () => {
	it('generates title prompt with source details', () => {
		const article = {
			title: 'Original',
			author: 'Author',
			source: 'Source',
			url: 'https://example.com/article',
			keywords: [],
			date: '2026-01-01',
			links: {}
		};
		expect(articleTitlePrompt(article, ['SCIENCE'])).toContain('Original');
	});
});

describe('articleSummaryPrompt', () => {
	it('includes article metadata and tags', () => {
		const article = {
			title: 'Original',
			author: 'Author',
			source: 'Source',
			url: 'https://example.com/article',
			abstract: 'Abstract',
			keywords: ['a'],
			date: '2026-01-01',
			links: {}
		};
		expect(articleSummaryPrompt(article, ['SCIENCE'])).toContain('SCIENCE');
	});
});

describe('articleRecommendationQuery', () => {
	it('joins activity labels in recommendation query', () => {
		expect(articleRecommendationQuery(['hiking', 'coding'])).toContain('hiking');
	});
});

describe('articleSimilarityQuery', () => {
	it('builds similarity prompt from article payload', () => {
		const article = {
			id: '1',
			title: 'A',
			description: 'D',
			tags: ['x'],
			content: 'Body',
			author: {},
			author_id: '1',
			color: 'red',
			color_hex: '#f00',
			created_at: '2026-01-01',
			ocean: {
				title: 'O',
				author: 'A',
				source: 'S',
				url: 'https://example.com/ocean',
				keywords: [],
				date: '2026-01-01',
				links: {}
			}
		} as Article;
		expect(articleSimilarityQuery(article)).toContain('Find articles similar');
	});
});

describe('promptsSystemMessage', () => {
	it('contains task instructions', () => {
		expect(promptsSystemMessage).toContain('Generate exactly ONE');
	});
});

describe('promptsQuestionPrompt', () => {
	it('returns a dynamic question-generation instruction', () => {
		expect(promptsQuestionPrompt()).toContain('Create a question');
	});
});

describe('eventDescriptionSystemMessage', () => {
	it('describes event summary constraints', () => {
		expect(eventDescriptionSystemMessage).toContain('Single paragraph');
	});
});

describe('eventDescriptionPrompt', () => {
	it('builds event prompt including title and date', () => {
		const entry = { name: "Vallejo's Birthday" } as any;
		expect(eventDescriptionPrompt(entry, new Date('2026-01-01'))).toContain("Vallejo's Birthday");
	});
});

describe('eventActivitySelectionQuery', () => {
	it('includes event name and snippet', () => {
		expect(eventActivitySelectionQuery('Name', 'Description')).toContain('Name');
	});
});

describe('eventRecommendationQuery', () => {
	it('includes activity labels', () => {
		expect(eventRecommendationQuery(['outdoors'])).toContain('outdoors');
	});
});

describe('eventSimilarityQuery', () => {
	it('builds event similarity query from event payload', () => {
		expect(
			eventSimilarityQuery({
				name: 'Earth Day',
				description: 'Description',
				date: Date.now(),
				type: 'ONLINE',
				visibility: 'PUBLIC',
				activities: ['NATURE'],
				fields: {}
			})
		).toContain('Find events similar');
	});
});

describe('promptCriteria', () => {
	it('has weighted criteria summing to 1.0', () => {
		const total = promptCriteria.reduce((sum, c) => sum + c.weight, 0);
		expect(total).toBeCloseTo(1, 5);
	});
});

describe('articleCriteria', () => {
	it('has weighted criteria summing to 1.0', () => {
		const total = articleCriteria.reduce((sum, c) => sum + c.weight, 0);
		expect(total).toBeCloseTo(1, 5);
	});
});

describe('eventImageCaptionPrompt', () => {
	it('includes event context and activity names', () => {
		const event = {
			id: '1',
			name: 'Cleanup',
			description: 'Beach cleanup event',
			type: 'IN_PERSON',
			date: Date.now(),
			visibility: 'PUBLIC',
			activities: [{ type: 'activity_type', value: 'NATURE' }],
			fields: {}
		} as unknown as Event;
		expect(eventImageCaptionPrompt(event)).toContain('Cleanup');
	});
});

describe('eventImageCriteria', () => {
	it('returns rubric items for event image grading', () => {
		const event = {
			id: '1',
			name: 'Cleanup',
			description: 'Beach cleanup event',
			type: 'IN_PERSON',
			date: Date.now(),
			visibility: 'PUBLIC',
			activities: [{ type: 'activity_type', value: 'NATURE' }],
			fields: {}
		} as unknown as Event;
		expect(eventImageCriteria(event).length).toBeGreaterThan(0);
	});
});

describe('userProfilePhotoPrompt', () => {
	it('returns model input prompt with user context', () => {
		const payload = userProfilePhotoPrompt({
			username: 'earthy',
			bio: 'bio',
			created_at: '2026-01-01',
			visibility: 'PUBLIC' as any,
			country: 'US',
			full_name: 'Earth User',
			activities: []
		});
		expect(payload.prompt).toContain('earthy');
	});
});

describe('generateProfilePhoto', () => {
	it('collects image chunks from ai stream', async () => {
		const ai = {
			run: vi.fn(async () => {
				const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4])];
				let idx = 0;
				return new ReadableStream<Uint8Array>({
					pull(controller) {
						if (idx < chunks.length) {
							controller.enqueue(chunks[idx++]);
						} else {
							controller.close();
						}
					}
				});
			})
		} as unknown as Ai;

		const image = await generateProfilePhoto(
			{
				username: 'earthy',
				bio: 'bio',
				created_at: '2026-01-01',
				visibility: 'PUBLIC' as any,
				country: 'US',
				full_name: 'Earth User',
				activities: []
			},
			ai
		);

		expect(Array.from(image)).toEqual([1, 2, 3, 4]);
	});
});
