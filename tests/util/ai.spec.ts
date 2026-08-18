import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	activityDescriptionPrompt,
	activityDescriptionSystemMessage,
	NOT_AN_ACTIVITY,
	NotAnActivityError,
	articleClassificationQuery,
	articleCriteria,
	articleRecommendationQuery,
	articleSimilarityQuery,
	articleSummaryPrompt,
	articleTitlePrompt,
	articleTopicPrompt,
	articleTopicSystemMessage,
	classifyEventEntry,
	eventActivitySelectionQuery,
	eventDescriptionPrompt,
	eventDescriptionSystemMessage,
	eventImageCaptionPrompt,
	eventImageCriteria,
	eventRecommendationQuery,
	eventSimilarityQuery,
	generateProfilePhoto,
	isPlaceBirthdaySource,
	logAIFailure,
	promptCriteria,
	promptsQuestionPrompt,
	promptsSystemMessage,
	sanitizeAIOutput,
	sanitizeForContentType,
	userProfilePhotoPrompt,
	validateActivityDescription,
	inferActivityTags,
	selectActivityIcon,
	validateActivityTags,
	validateArticleLenses,
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

describe('inferActivityTags', () => {
	it('recovers real tags from the name and description when the model returns nothing', () => {
		const tags = inferActivityTags(
			'bouldering',
			'A form of rock climbing performed on short walls outdoors without ropes.'
		);
		expect(tags).toContain('SPORT');
		expect(tags).not.toContain('OTHER');
	});

	it('ranks the tag with the most keyword hits first', () => {
		const tags = inferActivityTags(
			'watercolor painting',
			'An art practice using paint and pigment to draw and illustrate scenes.'
		);
		expect(tags[0]).toBe('ART');
	});

	it('caps at four tags', () => {
		const tags = inferActivityTags(
			'everything',
			'sport outdoor fitness craft art game learn comput club relax pet home fashion travel invest charity family hobby'
		);
		expect(tags.length).toBeLessThanOrEqual(4);
	});

	it('returns nothing rather than guessing when no keyword matches', () => {
		expect(inferActivityTags('zzzz', 'qqqq wwww')).toEqual([]);
	});
});

describe('selectActivityIcon', () => {
	it('prefers a lexical match over an unrelated icon in a better set', () => {
		// the old logic took the first mdi result regardless of relevance
		expect(selectActivityIcon(['mdi:art-track', 'lucide:gourd'], 'gourd')).toBe('lucide:gourd');
	});

	it('breaks ties on set preference when overlap is equal', () => {
		expect(selectActivityIcon(['nimbus:chess', 'mdi:chess'], 'chess')).toBe('mdi:chess');
	});

	it('prefers the tighter name when set and overlap match', () => {
		expect(selectActivityIcon(['mdi:chess-king-outline', 'mdi:chess'], 'chess')).toBe('mdi:chess');
	});

	it('matches on a token prefix so plurals still resolve', () => {
		expect(selectActivityIcon(['mdi:kayaking'], 'kayak')).toBe('mdi:kayaking');
	});

	it('ignores style suffixes when scoring so a real match wins', () => {
		// 'outline'/'round'/'fill' are style tokens, not meaning; only chess should score
		expect(selectActivityIcon(['mdi:outline-round-fill', 'lucide:chess'], 'chess')).toBe(
			'lucide:chess'
		);
	});

	it('falls back to a rounded icon in the best set when nothing shares a token', () => {
		expect(selectActivityIcon(['nimbus:wat', 'mdi:leaf', 'ph:plant-rounded'], 'gardening')).toBe(
			'ph:plant-rounded'
		);
	});

	it('falls back to plain set preference when nothing is rounded either', () => {
		expect(selectActivityIcon(['nimbus:wat', 'mdi:zzz'], 'bouldering')).toBe('mdi:zzz');
	});

	it('returns null for an empty result set', () => {
		expect(selectActivityIcon([], 'anything')).toBeNull();
	});
});

describe('validateActivityTags', () => {
	it('filters to known tags and falls back to OTHER', () => {
		expect(validateActivityTags('UNKNOWN_TAG', 'test')).toEqual(['OTHER']);
	});

	it('salvages tags whose underscore the model dropped (COMMUNITYSERVICE -> COMMUNITY_SERVICE)', () => {
		expect(validateActivityTags('COMMUNITYSERVICE', 'test')).toEqual(['COMMUNITY_SERVICE']);
	});

	it('keeps valid tags and drops unmatched ones rather than failing the whole set', () => {
		// the exact production failure: one salvageable tag + one tag with no real category
		expect(validateActivityTags('COMMUNITYSERVICE,ORGANISATIONALEVENT', 'test')).toEqual([
			'COMMUNITY_SERVICE'
		]);
	});

	it('normalizes spacing/hyphenation and de-duplicates', () => {
		expect(validateActivityTags('PERSONAL GOAL, home-improvement, PERSONAL_GOAL', 'test')).toEqual([
			'PERSONAL_GOAL',
			'HOME_IMPROVEMENT'
		]);
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

	it('accepts shorter descriptions for historical anniversary entries', () => {
		const description =
			'In 1946, ENIAC marked a turning point in computing by proving large-scale electronic calculation was practical, and its legacy shaped later software, hardware, and modern digital infrastructure.';
		expect(() =>
			validateEventDescription(description, 'ENIAC Unveiled', true, {
				name: 'ENIAC Unveiled',
				source: 'anniversaries/computers.csv'
			} as any)
		).not.toThrow();
	});
});

describe('event entry classification', () => {
	it('detects place birthday sources', () => {
		expect(isPlaceBirthdaySource('birthdays/us/counties.csv')).toBe(true);
		expect(
			classifyEventEntry({ name: "Bahamas' Birthday", source: 'birthdays/countries.csv' })
		).toBe('place_birthday');
	});

	it('detects organization birthdays and anniversaries', () => {
		expect(
			classifyEventEntry({ name: "Apple Inc's Birthday", source: 'birthdays/companies.csv' })
		).toBe('organization_birthday');
		expect(
			classifyEventEntry({
				name: 'Google Founded',
				source: 'anniversaries/computers.csv'
			})
		).toBe('historical_anniversary');
	});

	it('flags all place CSV subpaths as place birthdays', () => {
		const placeSources = [
			'birthdays/countries.csv',
			'birthdays/us/cities.csv',
			'birthdays/us/counties.csv',
			'birthdays/us/territories.csv',
			'birthdays/ca/cities.csv',
			'birthdays/ca/provinces.csv'
		];
		for (const source of placeSources) {
			expect(isPlaceBirthdaySource(source)).toBe(true);
		}
	});

	it('flags subdivision words outside the old whitelist as place birthdays', () => {
		// moho names first-level subdivisions after whatever the country calls
		// them, so these must not fall through to a generic kind
		const subdivisionSources = [
			'birthdays/ru/federal_subjects.csv',
			'birthdays/gb/subdivisions.csv',
			'birthdays/es/communities.csv',
			'birthdays/gl/municipalities.csv',
			'birthdays/sv/departments.csv',
			'birthdays/bw/districts.csv',
			'birthdays/mx/states.csv',
			'birthdays/hu/counties.csv'
		];
		for (const source of subdivisionSources) {
			expect(isPlaceBirthdaySource(source)).toBe(true);
			expect(classifyEventEntry({ name: "Somewhere's Birthday", source })).toBe('place_birthday');
		}
	});

	it('keeps organization files out of the place catch-all', () => {
		// colleges live under a country directory and must stay organizations
		for (const source of ['birthdays/us/colleges.csv', 'birthdays/ca/colleges.csv']) {
			expect(isPlaceBirthdaySource(source)).toBe(false);
			expect(classifyEventEntry({ name: "A University's Birthday", source })).toBe(
				'organization_birthday'
			);
		}
	});

	it('classifies sports clubs and governing bodies as organizations', () => {
		for (const source of ['sports/clubs.csv', 'sports/organizations.csv']) {
			expect(isPlaceBirthdaySource(source)).toBe(false);
			expect(classifyEventEntry({ name: "AC Milan's Birthday", source })).toBe(
				'organization_birthday'
			);
		}
	});

	it('rejects non-place birthday sources', () => {
		const nonPlaceSources = [
			'birthdays/companies.csv',
			'birthdays/international_orgs.csv',
			'birthdays/us/colleges.csv',
			'anniversaries/computers.csv',
			'events.csv',
			'events_d.csv',
			''
		];
		for (const source of nonPlaceSources) {
			expect(isPlaceBirthdaySource(source)).toBe(false);
		}
	});

	it('is case- and separator-insensitive', () => {
		expect(isPlaceBirthdaySource('Birthdays/US/Cities.csv')).toBe(true);
		expect(isPlaceBirthdaySource('birthdays\\us\\cities.csv')).toBe(true);
		expect(isPlaceBirthdaySource('./birthdays/countries.csv')).toBe(true);
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
		expect(articleTitlePrompt(article)).toContain('Original');
	});

	it('keeps the random lenses out of the title prompt', () => {
		const article = {
			title: 'Original',
			author: 'Author',
			source: 'Source',
			url: 'https://example.com/article',
			keywords: [],
			date: '2026-01-01',
			links: {}
		};
		expect(articleTitlePrompt(article)).not.toContain('LENSES');
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

	it('uses place-specific guidance for geographic birthday sources', () => {
		const entry = {
			name: "Vallejo's Birthday",
			source: 'birthdays/us/cities.csv'
		} as any;
		const prompt = eventDescriptionPrompt(entry, new Date('2026-01-01'));
		expect(prompt).toContain('birthday of a place');
	});

	it('uses organization-specific guidance for company birthdays', () => {
		const entry = {
			name: "Apple Inc's Birthday",
			source: 'birthdays/companies.csv'
		} as any;
		const prompt = eventDescriptionPrompt(entry, new Date('2026-01-01'));
		expect(prompt).toContain('organization, institution, company, or alliance');
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

describe('validateArticleLenses', () => {
	const offered = ['Art', 'Nature', 'Finance'];

	it('keeps the confirmed lenses in the input spelling', () => {
		expect(validateArticleLenses('art, NATURE', offered)).toEqual(['Art', 'Nature']);
	});

	it('ignores anything that was not offered', () => {
		expect(validateArticleLenses('Art, Sport', offered)).toEqual(['Art']);
	});

	it('folds duplicates', () => {
		expect(validateArticleLenses('Art, Art, art', offered)).toEqual(['Art']);
	});

	// fails CLOSED: a broken reply must not restore the full random draw
	it('falls back to the first lens on NONE, junk, or an empty reply', () => {
		expect(validateArticleLenses('NONE', offered)).toEqual(['Art']);
		expect(validateArticleLenses('!!!', offered)).toEqual(['Art']);
		expect(validateArticleLenses('', offered)).toEqual(['Art']);
	});

	it('returns nothing when nothing was offered', () => {
		expect(validateArticleLenses('Art', [])).toEqual([]);
	});
});

describe('articleSummaryPrompt lens instructions', () => {
	const article = {
		title: 'T',
		author: 'A',
		source: 'S',
		url: 'https://example.com/a',
		abstract: 'Abstract',
		keywords: ['k'],
		date: '2026-01-01',
		links: {}
	};

	// the exact failure this replaced: "incorporate the tags naturally into the text" made the
	// model assert a connection whether or not one existed
	it('tells the model to drop lenses it cannot ground', () => {
		const prompt = articleSummaryPrompt(article, ['Art']);
		expect(prompt).toContain('SILENTLY DROP');
		expect(prompt).not.toContain('integrate them naturally');
	});

	it('states that the lenses are random and not a description of the article', () => {
		expect(articleSummaryPrompt(article, ['Art'])).toContain('assigned at random');
	});
});

describe('activity description refusal', () => {
	it('offers the model an explicit way to refuse', () => {
		expect(activityDescriptionSystemMessage).toContain(NOT_AN_ACTIVITY);
		expect(activityDescriptionSystemMessage).toContain('water bottle');
	});

	// the refusal is a verdict about the candidate, not a generation failure
	it('throws NotAnActivityError rather than falling back to a description', () => {
		expect(() => validateActivityDescription(NOT_AN_ACTIVITY, 'water bottle', true)).toThrow(
			NotAnActivityError
		);
	});

	it('refuses even when throwOnFailure is off, instead of returning the generic fallback', () => {
		expect(() => validateActivityDescription(`${NOT_AN_ACTIVITY}\n`, 'marina', false)).toThrow(
			NotAnActivityError
		);
	});

	it('does not fire on a description that merely mentions the phrase mid-text', () => {
		const description = `${'word '.repeat(60)}it is not an activity for everyone, though many enjoy it regularly and find it rewarding over time.`;
		expect(() => validateActivityDescription(description, 'bouldering', true)).not.toThrow();
	});
});
