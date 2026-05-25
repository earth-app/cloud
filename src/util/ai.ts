import * as ocean from '@earth-app/ocean';
import {
	ActivityType,
	Article,
	Event,
	eventActivitiesList,
	EventData,
	OceanArticle
} from './types';
import { Entry, RelativeDateEntry } from '@earth-app/moho';
import { ScoringCriterion } from '../content/ferry';
import type { QuestStep } from '../user/quests';
import type { Badge } from '../user/badges';
import { clampInt, clampNumber } from './util';

// Validation and sanitation functions for AI outputs

export function logAIFailure(context: string, input: any, output: any, error: string): void {
	console.error(`AI Output Validation Failed [${context}]`, {
		timestamp: new Date().toISOString(),
		context,
		input,
		output,
		error,
		stack: new Error().stack
	});
}

export type EventEntryKind =
	| 'place_birthday'
	| 'organization_birthday'
	| 'historical_anniversary'
	| 'relative_observance'
	| 'birthday'
	| 'general';

const PLACE_BIRTHDAY_SOURCE_PATTERNS = [
	/^birthdays\/countries\.csv$/,
	/^birthdays\/[^/]+\/(?:cities|counties|provinces|territories|states|regions)\.csv$/
];

const ORGANIZATION_BIRTHDAY_SOURCE_PATTERNS = [
	/^birthdays\/companies\.csv$/,
	/^birthdays\/international_orgs\.csv$/,
	/^birthdays\/[^/]+\/colleges\.csv$/
];

function normalizeMohoSource(source?: string): string {
	if (!source) {
		return '';
	}

	return source.trim().replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

export function isPlaceBirthdaySource(source?: string): boolean {
	const normalizedSource = normalizeMohoSource(source);
	if (!normalizedSource) {
		return false;
	}

	return PLACE_BIRTHDAY_SOURCE_PATTERNS.some((pattern) => pattern.test(normalizedSource));
}

function isOrganizationBirthdaySource(source?: string): boolean {
	const normalizedSource = normalizeMohoSource(source);
	if (!normalizedSource) {
		return false;
	}

	return ORGANIZATION_BIRTHDAY_SOURCE_PATTERNS.some((pattern) => pattern.test(normalizedSource));
}

export function classifyEventEntry(entry: Pick<Entry, 'name' | 'source'>): EventEntryKind {
	const normalizedSource = normalizeMohoSource(entry.source);

	if (normalizedSource.startsWith('anniversaries/')) {
		return 'historical_anniversary';
	}

	if (isPlaceBirthdaySource(normalizedSource)) {
		return 'place_birthday';
	}

	if (isOrganizationBirthdaySource(normalizedSource)) {
		return 'organization_birthday';
	}

	if (
		entry instanceof RelativeDateEntry ||
		normalizedSource.endsWith('events_d.csv') ||
		/(?:^|\/)events_d\.csv$/.test(normalizedSource)
	) {
		return 'relative_observance';
	}

	if (/\bbirthday\b/i.test(entry.name || '')) {
		return 'birthday';
	}

	return 'general';
}

/**
 * Sanitizes AI-generated text by removing unwanted formatting, quotes, and characters
 * @param text - The text to sanitize
 * @param options - Sanitization options
 * @returns Sanitized text
 */
export function sanitizeAIOutput(
	text: string,
	options: {
		removeQuotes?: boolean;
		removeMarkdown?: boolean;
		removeExtraWhitespace?: boolean;
		removeBrackets?: boolean;
		preserveBasicPunctuation?: boolean;
		removeHTMLTags?: boolean;
	} = {}
): string {
	if (!text || typeof text !== 'string') {
		return '';
	}

	let cleaned = text.trim();

	// Default options
	const opts = {
		removeQuotes: true,
		removeMarkdown: true,
		removeExtraWhitespace: true,
		removeBrackets: false,
		preserveBasicPunctuation: true,
		removeHTMLTags: true,
		...options
	};

	// Remove "(Note: ...)" or "Note: ..." suffix
	cleaned = cleaned.replace(/\(Note:[^)]+\)\s*$/i, '').replace(/^\s*Note:\s*/i, '');

	// Remove markdown formatting
	if (opts.removeMarkdown) {
		cleaned = cleaned
			.replace(/```[\s\S]*?```/g, '') // Remove code blocks
			.replace(/`([^`]+)`/g, '$1') // Remove inline code backticks
			.replace(/\*\*([^*]+)\*\*/g, '$1') // Remove bold **text**
			.replace(/\*([^*]+)\*/g, '$1') // Remove italic *text*
			.replace(/__([^_]+)__/g, '$1') // Remove bold __text__
			.replace(/_([^_]+)_/g, '$1') // Remove italic _text_
			.replace(/#{1,6}\s*/g, '') // Remove headers
			.replace(/^\s*[-*+]\s+/gm, '') // Remove bullet points
			.replace(/^\s*\d+\.\s+/gm, '') // Remove numbered lists
			.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // Remove links [text](url) -> text
			.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1'); // Remove images ![alt](url) -> alt
	}

	// Remove quotes and similar wrapper characters
	if (opts.removeQuotes) {
		cleaned = cleaned
			.replace(/^["'`]+|["'`]+$/g, '') // Remove leading/trailing quotes
			.replace(/[""''`]/g, '') // Remove fancy quotes and backticks only (preserve apostrophes)
			.trim();
	}

	// Remove brackets and parentheses content (sometimes AI adds explanatory notes)
	if (opts.removeBrackets) {
		cleaned = cleaned
			.replace(/\[[^\]]*\]/g, '') // Remove [bracketed content]
			.replace(/\([^)]*\)/g, '') // Remove (parenthetical content)
			.trim();
	}

	// Clean up whitespace
	if (opts.removeExtraWhitespace) {
		cleaned = cleaned
			.replace(/\s+/g, ' ') // Multiple spaces to single space
			.replace(/\n\s*\n/g, '\n') // Multiple newlines to single newline
			.trim();
	}

	// Remove common AI output artifacts
	cleaned = cleaned
		.replace(
			/^(Here's|Here is|This is|The answer is|Response:|Output:|Summary:|Title:|Description:)\s*/i,
			''
		) // Remove AI prefixes
		.replace(/^(A|An|The)\s+(?=\w)/i, (match, article) => {
			// Only remove articles if they seem to be AI artifacts at the start
			const nextWords = cleaned.slice(match.length).split(' ').slice(0, 3).join(' ').toLowerCase();
			if (
				nextWords.includes('description') ||
				nextWords.includes('summary') ||
				nextWords.includes('title')
			) {
				return '';
			}
			return match;
		})
		.replace(/\.\s*\.+/g, '.') // Remove multiple periods
		.replace(/,\s*,+/g, ',') // Remove multiple commas
		.replace(/\s*\.\s*$/, '.') // Ensure single period at end if needed
		.replace(/\s*,\s*$/, '') // Remove trailing comma
		.trim();

	// Remove '(Note: ...)' or 'Note: ...' suffix
	cleaned = cleaned.replace(/\(Note:[^)]+\)\s*$/i, '').replace(/^\s*Note:\s*/i, '');

	// Optionally preserve basic punctuation
	if (opts.preserveBasicPunctuation) {
		// More permissive for descriptions - keep parentheses and other common punctuation
		cleaned = cleaned.replace(/[^\w\s.,!?;:'"()\-–—&%$#@]/g, ''); // Keep wider range of punctuation
	} else {
		cleaned = cleaned.replace(/[^a-zA-Z0-9\s]/g, ''); // Remove all punctuation
	}

	// Remove HTML tags if any
	if (opts.removeHTMLTags) {
		cleaned = cleaned.replace(/<\/?[^>]+(>|$)/g, '');
	}

	// Final trim
	cleaned = cleaned.trim();

	return cleaned;
}

/**
 * Additional sanitization for specific content types
 */
export function sanitizeForContentType(
	text: string,
	contentType: 'description' | 'title' | 'topic' | 'tags' | 'question'
): string {
	let cleaned = text;

	switch (contentType) {
		case 'description':
			cleaned = sanitizeAIOutput(cleaned, {
				removeQuotes: true,
				removeMarkdown: true,
				removeExtraWhitespace: true,
				removeBrackets: false,
				preserveBasicPunctuation: true,
				removeHTMLTags: true
			});
			break;

		case 'title':
			cleaned = sanitizeAIOutput(cleaned, {
				removeQuotes: true,
				removeMarkdown: true,
				removeExtraWhitespace: true,
				removeBrackets: true,
				preserveBasicPunctuation: true,
				removeHTMLTags: true
			});
			// Remove title-specific artifacts
			cleaned = cleaned.replace(/^(Title:|Article:|Study:)\s*/i, '');
			break;

		case 'topic':
			cleaned = sanitizeAIOutput(cleaned, {
				removeQuotes: true,
				removeMarkdown: true,
				removeExtraWhitespace: true,
				removeBrackets: true,
				preserveBasicPunctuation: false,
				removeHTMLTags: true
			});
			// Keep only alphanumeric and spaces for topics
			cleaned = cleaned.replace(/[^a-zA-Z0-9\s-]/g, '').trim();
			break;

		case 'tags':
			cleaned = sanitizeAIOutput(cleaned, {
				removeQuotes: true,
				removeMarkdown: true,
				removeExtraWhitespace: true,
				removeBrackets: true,
				preserveBasicPunctuation: true,
				removeHTMLTags: true
			});
			// Clean up tag separators
			cleaned = cleaned.replace(/[;|]/g, ',').replace(/\s*,\s*/g, ',');
			break;

		case 'question':
			cleaned = sanitizeAIOutput(cleaned, {
				removeQuotes: true,
				removeMarkdown: true,
				removeExtraWhitespace: true,
				removeBrackets: true,
				preserveBasicPunctuation: true,
				removeHTMLTags: true
			});
			// Ensure proper question format
			if (!cleaned.endsWith('?') && !cleaned.endsWith('.')) {
				cleaned += '?';
			}
			break;
	}

	return cleaned.trim();
}

export function validateActivityDescription(
	description: string,
	activityName: string,
	throwOnFailure: boolean = false
): string {
	try {
		if (!description || typeof description !== 'string') {
			logAIFailure('ActivityDescription', activityName, description, 'Invalid response type');
			throw new Error(`Failed to generate valid description for activity: ${activityName}`);
		}

		// Sanitize the description first
		const sanitized = sanitizeForContentType(description, 'description');

		const cleaned = sanitized.trim();
		const wordCount = cleaned.split(/\s+/).filter(Boolean).length;

		// Enforce both a char floor (catches blank/very short replies) and a word floor
		// (catches output that hit max_tokens mid-stream but happens to clear 200 chars).
		// 50 words ≈ 2-3 sentences — anything shorter is not a usable description.
		if (cleaned.length < 200 || wordCount < 50) {
			logAIFailure(
				'ActivityDescription',
				activityName,
				cleaned,
				`Description too short: ${wordCount} words / ${cleaned.length} chars`
			);
			throw new Error(`Generated description too short for activity: ${activityName}`);
		}

		if (wordCount > 500) {
			logAIFailure(
				'ActivityDescription',
				activityName,
				cleaned,
				`Description too long: ${wordCount} words`
			);
			throw new Error(`Generated description too long for activity: ${activityName}`);
		}

		// Check for remaining unwanted formatting after sanitization
		if (cleaned.includes('```') || cleaned.includes('**') || cleaned.includes('##')) {
			logAIFailure('ActivityDescription', activityName, cleaned, 'Contains markdown formatting');
			throw new Error(
				`Generated description contains invalid formatting for activity: ${activityName}`
			);
		}

		// Ensure ends in proper punctuation
		if (!/[.!?]$/.test(cleaned)) {
			logAIFailure(
				'ActivityDescription',
				activityName,
				cleaned,
				'Does not end with proper punctuation'
			);
			throw new Error(`Generated description does not end properly for activity: ${activityName}`);
		}

		return cleaned;
	} catch (error) {
		// If throwOnFailure is true, re-throw the error for retry logic
		if (throwOnFailure) {
			throw error;
		}

		// Otherwise, fail closed with a safe fallback
		const fallback = `${activityName.replace(/_/g, ' ')} is an engaging activity that offers unique experiences and opportunities for personal growth.`;
		logAIFailure(
			'ActivityDescription',
			activityName,
			description,
			`Validation failed, using fallback: ${error}`
		);
		return fallback;
	}
}

export function validateActivityTags(tagsResponse: string, activityName: string): ActivityType[] {
	try {
		if (!tagsResponse || typeof tagsResponse !== 'string') {
			logAIFailure('ActivityTags', activityName, tagsResponse, 'Invalid response type');
			return ['OTHER'];
		}

		// Sanitize the tags response
		const sanitized = sanitizeForContentType(tagsResponse, 'tags');

		const validTags = ocean.com.earthapp.activity.ActivityType.values().map((t) =>
			t.name.trim().toUpperCase()
		);

		const tags = sanitized
			.trim()
			.split(',')
			.map((tag) => tag.trim().toUpperCase())
			.filter((tag) => tag.length > 0)
			.filter((tag) => validTags.includes(tag));

		if (tags.length === 0) {
			logAIFailure('ActivityTags', activityName, sanitized, 'No valid tags found');
			return ['OTHER'];
		}

		if (tags.length > 5) {
			console.warn('Too many tags generated, limiting to 5', { tags, activityName });
			return tags.slice(0, 5) as ActivityType[];
		}

		return tags as ActivityType[];
	} catch (error) {
		logAIFailure('ActivityTags', activityName, tagsResponse, `Validation error: ${error}`);
		return ['OTHER'];
	}
}

export function validateArticleTopic(topicResponse: string): string {
	try {
		if (!topicResponse || typeof topicResponse !== 'string') {
			logAIFailure('ArticleTopic', 'N/A', topicResponse, 'Invalid response type');
			throw new Error('Failed to generate valid article topic');
		}

		// Sanitize the topic response
		const sanitized = sanitizeForContentType(topicResponse, 'topic');

		const topic = sanitized.replace(/\n/g, ' ').toLowerCase();
		const wordCount = topic.split(/\s+/).length;

		if (topic.length < 3) {
			logAIFailure('ArticleTopic', 'N/A', topic, `Topic too short: ${topic.length} chars`);
			throw new Error('Generated article topic too short');
		}

		if (wordCount > 6) {
			logAIFailure('ArticleTopic', 'N/A', topic, `Topic too long: ${wordCount} words`);
			throw new Error('Generated article topic too long');
		}

		if (!/^[a-zA-Z0-9\s-]+$/.test(topic)) {
			logAIFailure('ArticleTopic', 'N/A', topic, 'Contains invalid characters');
			throw new Error('Generated article topic contains invalid characters');
		}

		return topic;
	} catch (error) {
		logAIFailure('ArticleTopic', 'N/A', topicResponse, `Validation failed: ${error}`);
		throw error; // Re-throw since there's no safe fallback for article topics
	}
}

export function validateArticleTitle(titleResponse: string, originalTitle: string): string {
	try {
		if (!titleResponse || typeof titleResponse !== 'string') {
			logAIFailure('ArticleTitle', originalTitle, titleResponse, 'Invalid response type');
			throw new Error('Failed to generate valid article title');
		}

		// Sanitize the title
		const sanitized = sanitizeForContentType(titleResponse, 'title');

		const title = sanitized.trim();
		const wordCount = title.split(/\s+/).length;

		if (title.length < 5) {
			logAIFailure('ArticleTitle', originalTitle, title, `Title too short: ${title.length} chars`);
			throw new Error('Generated article title too short');
		}

		if (wordCount > 35) {
			logAIFailure('ArticleTitle', originalTitle, title, `Title too long: ${wordCount} words`);
			throw new Error('Generated article title too long');
		}

		// Check for remaining unwanted formatting after sanitization
		if (title.includes('"') || title.includes('```') || title.includes('*')) {
			logAIFailure('ArticleTitle', originalTitle, title, 'Contains unwanted formatting');
			throw new Error('Generated article title contains invalid formatting');
		}

		// Check for alternative titles or multiple titles
		if (/\s+or\s+/i.test(title)) {
			logAIFailure('ArticleTitle', originalTitle, title, 'Contains alternative titles');
			throw new Error('Generated article title contains alternative titles');
		}

		return title;
	} catch (error) {
		logAIFailure('ArticleTitle', originalTitle, titleResponse, `Validation failed: ${error}`);
		throw error; // Re-throw since titles need to be valid
	}
}

export function validateArticleSummary(summaryResponse: string, originalTitle: string): string {
	try {
		if (!summaryResponse || typeof summaryResponse !== 'string') {
			logAIFailure('ArticleSummary', originalTitle, summaryResponse, 'Invalid response type');
			throw new Error('Failed to generate valid article summary');
		}

		// Sanitize the summary
		const sanitized = sanitizeAIOutput(summaryResponse, {
			removeQuotes: true,
			removeMarkdown: true,
			removeExtraWhitespace: true,
			removeBrackets: false, // Keep brackets as they might contain important citations
			preserveBasicPunctuation: true
		});

		const summary = sanitized.trim();
		const wordCount = summary.split(/\s+/).length;

		if (summary.length < 400) {
			logAIFailure(
				'ArticleSummary',
				originalTitle,
				summary,
				`Summary too short: ${summary.length} chars`
			);
			throw new Error('Generated article summary too short');
		}

		if (wordCount > 900) {
			logAIFailure(
				'ArticleSummary',
				originalTitle,
				summary,
				`Summary too long: ${wordCount} words`
			);
			throw new Error('Generated article summary too long');
		}

		return summary;
	} catch (error) {
		logAIFailure('ArticleSummary', originalTitle, summaryResponse, `Validation failed: ${error}`);
		throw error; // Re-throw since summaries need to be valid
	}
}

export function validatePromptQuestion(questionResponse: string): string {
	try {
		if (!questionResponse || typeof questionResponse !== 'string') {
			logAIFailure('PromptQuestion', 'N/A', questionResponse, 'Invalid response type');
			throw new Error('Failed to generate valid prompt question');
		}

		// Sanitize the question
		const sanitized = sanitizeForContentType(questionResponse, 'question');

		const question = sanitized.replace(/\n/g, ' ');
		const wordCount = question.split(/\s+/).length;

		if (question.length < 10) {
			logAIFailure(
				'PromptQuestion',
				'N/A',
				question,
				`Question too short: ${question.length} chars`
			);
			throw new Error('Generated prompt question too short');
		}

		if (question.length > 100) {
			logAIFailure(
				'PromptQuestion',
				'N/A',
				question,
				`Question too long: ${question.length} chars`
			);
			throw new Error('Generated prompt question too long');
		}

		if (wordCount > 25) {
			logAIFailure('PromptQuestion', 'N/A', question, `Too many words: ${wordCount}`);
			throw new Error('Generated prompt question too long');
		}

		// Check for prohibited phrases. Use word boundaries so short tokens like 'i'/'my'
		// do not match incidental substrings inside other words. 'what if' is allowed because
		// it appears in the `prefixes` pool below; the system prompt also still discourages it.
		const prohibitedWords = ['imagine', 'you', 'your', 'i', 'my', 'we', 'our'];
		const lowerQuestion = question.toLowerCase();

		for (const word of prohibitedWords) {
			const pattern = new RegExp(`\\b${word}\\b`);
			if (pattern.test(lowerQuestion)) {
				logAIFailure('PromptQuestion', 'N/A', question, `Contains prohibited word: ${word}`);
				throw new Error('Generated prompt question contains prohibited phrase');
			}
		}

		return question;
	} catch (error) {
		logAIFailure('PromptQuestion', 'N/A', questionResponse, `Validation failed: ${error}`);
		throw error; // Re-throw since prompts need to be valid
	}
}

export function validateEventDescription(
	description: string,
	name: string,
	throwOnFailure: boolean = false,
	entry?: Pick<Entry, 'name' | 'source'>
): string {
	const eventKind = entry
		? classifyEventEntry(entry)
		: /\bbirthday\b/i.test(name)
			? 'birthday'
			: 'general';

	try {
		if (!description || typeof description !== 'string') {
			logAIFailure('EventDescription', name, description, 'Invalid response type');
			throw new Error(`Failed to generate valid description for event: ${name}`);
		}

		// Sanitize the description first
		const sanitized = sanitizeForContentType(description, 'description');

		const cleaned = sanitized.trim();
		const wordCount = cleaned.split(/\s+/).length;
		const minLength = eventKind === 'historical_anniversary' ? 140 : 180;
		const maxWords = eventKind === 'historical_anniversary' ? 650 : 700;

		if (cleaned.length < minLength) {
			logAIFailure(
				'EventDescription',
				name,
				cleaned,
				`Description too short for ${eventKind}: ${cleaned.length} chars`
			);
			throw new Error(`Generated description too short for event: ${name}`);
		}

		if (wordCount > maxWords) {
			logAIFailure(
				'EventDescription',
				name,
				cleaned,
				`Description too long for ${eventKind}: ${wordCount} words`
			);
			throw new Error(`Generated description too long for event: ${name}`);
		}

		const lowerCleaned = cleaned.toLowerCase();
		const refusalIndicators = [
			'as an ai',
			'i cannot',
			"i can't",
			'unable to provide',
			'no information available'
		];

		if (refusalIndicators.some((indicator) => lowerCleaned.includes(indicator))) {
			logAIFailure('EventDescription', name, cleaned, 'Contains refusal or placeholder language');
			throw new Error(`Generated description was not usable for event: ${name}`);
		}

		// Check for remaining unwanted formatting after sanitization
		if (cleaned.includes('```') || cleaned.includes('**') || cleaned.includes('##')) {
			logAIFailure('EventDescription', name, cleaned, 'Contains markdown formatting');
			throw new Error(`Generated description contains invalid formatting for event: ${name}`);
		}

		// Ensure ends in proper punctuation
		if (!/[.!?]$/.test(cleaned)) {
			logAIFailure('EventDescription', name, cleaned, 'Does not end with proper punctuation');
			throw new Error(`Generated description does not end properly for event: ${name}`);
		}

		return cleaned;
	} catch (error) {
		// If throwOnFailure is true, re-throw the error for retry logic
		if (throwOnFailure) {
			throw error;
		}

		// Otherwise, fail closed with a safe fallback
		let fallback = `The event "${name}" is an informative observance that offers historical context and opportunities for learning.`;
		if (eventKind === 'place_birthday') {
			fallback = `The event "${name}" marks a historical milestone for a place and highlights its origins, context, and significance.`;
		} else if (eventKind === 'organization_birthday') {
			fallback = `The event "${name}" marks the founding or milestone of an organization and offers context about its history and impact.`;
		} else if (eventKind === 'historical_anniversary') {
			fallback = `The event "${name}" commemorates a historical milestone and invites exploration of what happened and why it still matters.`;
		}

		logAIFailure(
			'EventDescription',
			name,
			description,
			`Validation failed, using fallback: ${error}`
		);

		return fallback;
	}
}

// Activity Prompts

export const activityDescriptionSystemMessage = `
You are an expert in describing activities to a general audience.

TASK: Generate a single paragraph description of the given activity.

REQUIREMENTS:
- Length: 150-250 words, approximately 1-2 minutes read
- Focus: What the activity involves, its history or cultural context, what makes it interesting, and how people engage with it
- Format: Single complete paragraph, no bullet points, quotes, or special formatting
- Tone: Informative and neutral, fostering curiosity without promotional language
- Language: Simple, clear, accessible to beginners
- Content: Include practical information, interesting facts, and ways people connect through this activity
- Avoid prescriptive language like "you should" or "must" - instead describe what people typically do or discover
- No emojis, special characters, or markdown formatting
- CRITICAL: Must end with proper punctuation (period, exclamation mark, or question mark)
- CRITICAL: Must form a complete, coherent paragraph with a clear beginning, middle, and end

OUTPUT FORMAT: Return only the description text as a single complete paragraph ending with proper punctuation. Do not add any introductions, titles, or extra text.
`;

export const activityDescriptionPrompt = (activity: string): string => {
	return `Describe the activity: "${activity}"

Focus on:
- What the activity involves and its origins or cultural background
- What people find interesting or meaningful about it
- Ways people learn, practice, or engage with it
- What makes it accessible or approachable for newcomers

Write in an informative, welcoming tone that sparks curiosity about the activity.
Maintain grammatical correctness and keep the description as a single paragraph
that flows naturally from start to finish. The activity should be described clearly
for someone unfamiliar with it, emphasizing discovery and connection rather than promotion.
Do not use quotes, bullet points, or special formatting. Ensure it ends with proper punctuation
and is at least 150 words long but no more than 250 words.`;
};

export const activityTagsSystemMessage = `
You are a categorization expert. Given an activity name, output ONLY the appropriate tags from this list:

VALID TAGS: ${ocean.com.earthapp.activity.ActivityType.values()
	.map((t) => `"${t.name.toUpperCase()}"`)
	.join(', ')}

RULES:
- Output: Up to 5 tags separated by commas
- Format: Exact tag names only, uppercase, no quotes
- Example: SPORT,HEALTH,NATURE,TRAVEL
- No explanations, context, or other text
- Must use tags from the list above exactly as shown
- Choose the most relevant and general tags that apply

If uncertain, default to fewer tags rather than incorrect ones.
`;

// Article Prompts

export const articleTopicSystemMessage = `
You are an expert at generating scientific research topics.

TASK: Generate a concise search term for finding scientific articles.

REQUIREMENTS:
- Length: 1-3 words maximum
- Focus: Scientific, academic, or research topics
- Style: Generic enough to find multiple relevant articles
- Format: Simple terms, no special characters

OUTPUT FORMAT: Return only the topic words, nothing else.
`;

const topicExamples = [
	'self growth',
	'perseverance',
	'mental wellness',
	'social connection',
	'cognitive development',
	'mathematics',
	'physics',
	'psychology',
	'reading',
	'writing',
	'engineering',
	'biology',
	'chemistry',
	'climate science',
	'astronomy',
	'music cognition',
	'artificial intelligence',
	'robotics',
	'data science',
	'mindfulness',
	'medical research',
	'genetics',
	'neuroscience',
	'ecology',
	'oceanography',
	'linguistics',
	'philosophy',
	'ethics',
	'anthropology',
	'sociology',
	'community building',
	'education',
	'learning science',
	'kids development',
	'animal studies',
	'sports medicine',
	'aviation',
	'computer science',
	'psychiatry',
	'computer art',
	'historical science',
	'social studies',
	'public health',
	'epidemiology',
	'quantum mechanics',
	'materials science',
	'thermodynamics',
	'electromagnetism',
	'fluid dynamics',
	'geophysics',
	'volcanology',
	'seismology',
	'paleontology',
	'archaeology',
	'forensic science',
	'toxicology',
	'pharmacology',
	'immunology',
	'microbiology',
	'virology',
	'mycology',
	'botany',
	'zoology',
	'entomology',
	'marine biology',
	'evolutionary biology',
	'cell biology',
	'molecular biology',
	'biochemistry',
	'biophysics',
	'biomechanics',
	'bioethics',
	'cognitive science',
	'behavioral science',
	'developmental psychology',
	'social psychology',
	'clinical psychology',
	'neuropsychology',
	'psycholinguistics',
	'gerontology',
	'pediatrics',
	'nutrition science',
	'exercise physiology',
	'sleep science',
	'pain management',
	'addiction research',
	'trauma research',
	'urban planning',
	'environmental science',
	'conservation biology',
	'soil science',
	'hydrology',
	'meteorology',
	'glaciology',
	'renewable energy',
	'nuclear physics',
	'particle physics',
	'astrophysics',
	'cosmology',
	'space exploration',
	'satellite technology',
	'nanotechnology',
	'biotechnology',
	'genetic engineering',
	'stem cell research',
	'cancer research',
	'cardiology',
	'dermatology',
	'ophthalmology',
	'audiology',
	'speech pathology',
	'occupational therapy',
	'physical therapy',
	'telemedicine',
	'health informatics',
	'biostatistics',
	'econometrics',
	'behavioral economics',
	'game theory',
	'network theory',
	'information theory',
	'cryptography',
	'cybersecurity',
	'machine learning',
	'natural language processing',
	'computer vision',
	'human computer interaction',
	'virtual reality',
	'augmented reality',
	'drone technology',
	'autonomous vehicles',
	'structural engineering',
	'civil engineering',
	'chemical engineering',
	'electrical engineering',
	'mechanical engineering',
	'agricultural science',
	'food science',
	'textile science',
	'architecture',
	'urban sociology',
	'political science',
	'international relations',
	'media studies',
	'cultural anthropology',
	'cognitive anthropology',
	'comparative religion',
	'moral philosophy',
	'epistemology',
	'decision making',
	'creativity research',
	'positive psychology',
	'motivation science',
	'emotion regulation',
	'social cognition',
	'memory research',
	'attention research',
	'perception science',
	'child psychology',
	'adolescent development',
	'adult learning',
	'science communication'
];

export const articleTopicPrompt = (): string => {
	const example = topicExamples[Math.floor(Math.random() * topicExamples.length)];
	return example;
};

export const articleClassificationQuery = (topic: string, tags: string[]): string => {
	return `Articles primarily related to ${topic} and ${tags.length > 1 ? 'these tags' : 'this tag'}: ${tags
		.map((tag) => `"${tag}"`)
		.join(', ')} in that order. Disregard articles that are not primarily focused on ${topic}.`;
};

export const articleSystemMessage = `
You are an expert science writer specializing in accessible article summaries.

TASK: Write an engaging summary of the provided scientific article.

REQUIREMENTS:
- Incorporate the provided tags naturally into the summary
- Length: 250-600 words, ensure cohesive flow and minimum is met
- Tone: Informative yet accessible to general audiences
- Format: Well-structured paragraphs, no special formatting
- Focus: Key findings, implications, and relevance

OUTPUT FORMAT: Return only the summary text, no introduction or metadata.
`;

export const articleTitlePrompt = (article: OceanArticle, tags: string[]): string => {
	return `Generate an engaging title for this article:

Original Title: "${article.title}"
Author: ${article.author}
Source: ${article.source}

Related Tags: ${tags.join(', ')}

REQUIREMENTS:
- Maximum 10 words
- Engaging and accessible tone
- Reflect the article's content and the provided tags
- No quotes or special formatting
- No explanations or additional text other than the title
- No alternative titles, only a singular title
- MUST be unique and creative - avoid generic titles
- MUST be a complete, grammatically correct phrase
- Transform the original title significantly to create something fresh and distinctive
- Use specific, vivid language that captures the essence of the research

OUTPUT: Title only, no explanations.`;
};

export const articleSummaryPrompt = (article: OceanArticle, tags: string[]): string => {
	return `Summarize this article incorporating these tags: ${tags.join(', ')}

Article Information:
- Title: "${article.title}"
- Author: ${article.author}
- Source: ${article.source}
- Published: ${article.date}
- Keywords: ${article.keywords.join(', ')}

Abstract:
${article.abstract}

INSTRUCTIONS:
- Write an engaging summary that incorporates the provided tags
- Focus on key findings and their significance
- Make it accessible to a general audience
- Consider the publication date for relevance context
- Length: 250-600 words, ensure cohesive flow and minimum is met
- Tone: Informative yet approachable
- When including the tags, integrate them naturally into the text in a way that makes sense contextually
- No quotes, bullet points, special formatting, or additional text
- CRITICAL: Write complete, coherent sentences with proper grammar and punctuation
- CRITICAL: End with a proper concluding sentence - do NOT leave the summary incomplete or cut off mid-sentence
- Ensure every paragraph flows naturally and the entire summary reads as a polished, finished piece
- Vary your writing style and vocabulary to create unique summaries that avoid repetitive patterns
- Each summary should have its own distinct voice and structure
`;
};

export const articleRecommendationQuery = (activities: string[]): string => {
	return `Recommend articles related to these activities: ${activities
		.map((a) => `"${a}"`)
		.join(
			', '
		)}. Focus on articles that provide insights, information, or context relevant to these activities.`;
};

export const articleSimilarityQuery = (article: Article): string => {
	return `Find articles similar to this one based on its provided content and metadata:

Title: "${article.title}"
Author: ${article.author}
Tags: ${article.tags.join(', ')}

Excerpt:
${article.content.length > 500 ? `${article.content.substring(0, 500)}... (truncated)` : article.content}

Focus on articles that share similar themes, topics, or subject matter.
`;
};

export const articleQuizSystemMessage = `
You are an expert quiz creator specializing in educational content.

TASK: Generate a quiz based on the provided article.

REQUIREMENTS:
- Format: Mix of multiple choice and true/false
- Difficulty: Varying levels, from basic recall to critical thinking
- Clarity: Clear, concise wording
- Relevance: Directly related to article content
- No personal pronouns or conversational language
- Provide correct answers and brief explanations for each question

OUTPUT FORMAT: Return only the quiz questions, answer choices, correct answers, and explanations.
`;

export const articleQuizPrompt = `
Generate a quiz with brief questions (multiple choice and true/false) based on the article.

REQUIREMENTS:
- Mix of multiple choice (2-4 options) and true/false
- Concise (max 100 chars per question, 60 per option)
- Directly related to article content

OUTPUT: Return the quiz as JSON.
`;

// Prompts Prompts

export const promptsSystemMessage = `
Current date: ${new Date().toISOString().split('T')[0]}

TASK: Generate exactly ONE original, thought-provoking question that encourages reflection and curiosity.

REQUIREMENTS:
- Length: Under 15 words, under 100 characters
- Format: End with '?' if appropriate
- Style: Open-ended (not yes/no), clear, grammatically correct
- Content: Timeless, inviting exploration and diverse perspectives
- Language: Simple English, maximum one comma
- Tone: Neutral and inclusive - avoid prescriptive or judgmental framing
- Avoid: Personal pronouns, "what if", "imagine", clichés, company names, specific events, loaded language

EXAMPLES OF GOOD QUESTIONS:
- "What drives people to take creative risks?"
- "How does curiosity shape learning?"
- "Why do some habits stick while others fade?"
- "What role does wonder play in discovery?"

OUTPUT: Return only the question, nothing else.
`;

const prefixes = [
	'Who',
	'What',
	'When',
	'Where',
	'Why',
	'How',
	'Would',
	'If',
	'Which',
	'Can',
	'Could',
	'Should',
	'Is',
	'Are',
	'Do',
	'Does',
	'Have',
	'Has',
	'Will',
	'In',
	'Does',
	'Might',
	'What if',
	'To what extent',
	'In what ways',
	'How often',
	'How much',
	'How far',
	'Why do',
	'What makes',
	'What shapes',
	'What connects',
	'What separates',
	'What defines'
];

const topics = [
	'life',
	'technology',
	'science',
	'art',
	'history',
	'travel',
	'culture',
	'philosophy',
	'nature',
	'health',
	'education',
	'society',
	'innovation',
	'creativity',
	'personal growth',
	'human behavior',
	'future trends',
	'sustainability',
	'global issues',
	'psychology',
	'communication',
	'productivity',
	'leadership',
	'teamwork',
	'ethics',
	'design',
	'inspiration',
	'motivation',
	'wellness',
	'fitness',
	'mindfulness',
	'travel experiences',
	'cultural differences',
	'technological advancements',
	'scientific discoveries',
	'perseverance',
	'integrity',
	'mental wellness',
	'social connection',
	'belonging',
	'work-life balance',
	'remote work',
	'self-care',
	'nutrition',
	'mindfulness',
	'energy',
	'resilience',
	'curiosity',
	'wonder',
	'open-mindedness',
	'critical thinking',
	'emotional intelligence',
	'collaboration',
	'problem-solving',
	'adaptability',
	'innovation',
	'creative expression',
	'meaningful goals',
	'presence',
	'decision making',
	'conflict resolution',
	'community',
	'personal growth',
	'exploration',
	'discovery',
	'learning',
	'photography',
	'gardening',
	'cooking',
	'language learning',
	'storytelling',
	'human connection',
	'memory',
	'perception',
	'identity',
	'meaning',
	'purpose',
	'solitude',
	'silence',
	'ritual',
	'play',
	'humor',
	'imagination',
	'intuition',
	'trust',
	'vulnerability',
	'forgiveness',
	'gratitude',
	'patience',
	'courage',
	'fear',
	'ambition',
	'legacy',
	'tradition',
	'change',
	'uncertainty',
	'risk',
	'failure',
	'success',
	'fairness',
	'justice',
	'freedom',
	'borders',
	'language',
	'symbols',
	'metaphor',
	'time',
	'habit',
	'routine',
	'spontaneity',
	'simplicity',
	'complexity',
	'beauty',
	'taste',
	'sound',
	'movement',
	'rhythm',
	'craft',
	'mastery',
	'teaching',
	'mentorship',
	'childhood',
	'aging',
	'death',
	'grief',
	'joy',
	'boredom',
	'distraction',
	'attention',
	'observation',
	'empathy',
	'kindness',
	'generosity',
	'competition',
	'cooperation',
	'power',
	'influence',
	'persuasion',
	'truth',
	'bias',
	'perspective',
	'disagreement',
	'consensus',
	'systems thinking',
	'pattern recognition',
	'urban life',
	'wilderness',
	'architecture',
	'material culture',
	'food systems',
	'sleep',
	'dreams',
	'consciousness',
	'belief',
	'doubt',
	'mystery'
];

export const promptsQuestionPrompt = () => {
	const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
	const topic = topics[Math.floor(Math.random() * topics.length)];

	return `Create a question with the prefix '${prefix}' about '${topic}' that is open-ended, engaging, and thought-provoking.`;
};

// Events

export const eventDescriptionSystemMessage = `
You are an expert event describer.

TASK: Generate a concise, engaging description for the given event title and metadata.

REQUIREMENTS:
- Focus: What the event celebrates or commemorates, its history and significance, interesting facts, and learning opportunities
- Bounds: There is no guarantee that any in-person attendance or online organization exists; assume it is an informational event
and focus on the event's history, meaning, and context
- Classification awareness: Event titles may refer to places, organizations, institutions, or historical milestones; do not assume every "Birthday" refers to a place
- Tone: Informative and welcoming, sparking curiosity without promotional pressure
- Format: Single paragraph, no bullet points or special formatting, complete sentences
- Emphasize discovery, learning, and connection rather than obligations or imperatives

OUTPUT FORMAT: Return only the description text as a single complete paragraph.
`;

export const eventDescriptionPrompt = (entry: Entry, date: Date): string => {
	const entryKind = classifyEventEntry(entry);
	const sourceLabel = entry.source || 'unknown';

	let kindSpecificGuidance =
		'IMPORTANT: Keep the description neutral and grounded in verifiable historical context.';

	if (entryKind === 'place_birthday') {
		kindSpecificGuidance =
			'IMPORTANT: This is a birthday of a place (country, city, county, province, territory, or region), not a person or animal. Focus on the geographic or civic entity and its historical development.';
	} else if (entryKind === 'organization_birthday') {
		kindSpecificGuidance =
			'IMPORTANT: This is a founding birthday of an organization, institution, company, or alliance. Do not describe it as a country or city birthday.';
	} else if (entryKind === 'historical_anniversary') {
		kindSpecificGuidance =
			'IMPORTANT: This is a historical milestone anniversary. Focus on what happened, why it was significant at the time, and what impact it had later.';
	} else if (entryKind === 'relative_observance') {
		kindSpecificGuidance =
			'IMPORTANT: This observance follows a relative calendar rule (such as the nth weekday of a month). Emphasize the observance and its meaning rather than fixed-year milestones.';
	} else if (entryKind === 'birthday') {
		kindSpecificGuidance =
			'IMPORTANT: The title includes "Birthday," but the subject may be a place, organization, or another entity. Infer carefully from context and avoid person-centered assumptions unless explicitly supported.';
	}

	return `Describe the event titled "${entry.name}" happening on ${date.toISOString()}. This is primarily an informational
observance without specific location.

Entry metadata:
- Source file: ${sourceLabel}
- Classification: ${entryKind}

${kindSpecificGuidance}

Focus on:
- What the event celebrates or commemorates
- Historical context and significance
- Interesting facts or cultural aspects
- Learning opportunities or ways to explore the topic
- How people might engage with or reflect on this event

Write in an informative, welcoming tone that sparks curiosity about the event.
Keep the description to a single paragraph that flows naturally from start to finish.
Avoid promotional or prescriptive language. Do not use quotes, bullet points, or special formatting.
Ensure it ends with proper punctuation and has complete sentences.`;
};

export const eventActivitySelectionQuery = (
	eventName: string,
	eventDescription: string
): string => {
	return `Select the most relevant activities for this event:

Event: "${eventName}"
Description: ${eventDescription.substring(0, 300)}

Choose activities that closely match the event's theme, purpose, and expected attendees.`;
};

export const eventRecommendationQuery = (activities: string[]): string => {
	return `Recommend events related to these activities: ${activities
		.map((a) => `"${a}"`)
		.join(
			', '
		)}. Focus on events that provide insights, information, or context relevant to these events and activities.`;
};

export const eventSimilarityQuery = (event: EventData): string => {
	return `Find events similar to this one based on its provided content and metadata:

Name: "${event.name}"
Date: ${event.date}
Activities: ${event.activities.join(', ')}

Excerpt:
${event.description.length > 500 ? `${event.description.substring(0, 500)}... (truncated)` : event.description}

Focus on events that share similar themes, topics, or subject matter.
`;
};

export const promptCriteria: ScoringCriterion[] = [
	{
		id: 'linguistic_quality',
		weight: 0.2,
		ideal:
			'The question is grammatically correct, well-structured, and easy to read without introducing ambiguity.'
	},
	{
		id: 'semantic_clarity',
		weight: 0.25,
		ideal:
			'The question communicates its intent clearly and can be understood without additional context or interpretation.'
	},
	{
		id: 'conceptual_distinctiveness',
		weight: 0.25,
		ideal:
			'The question explores a topic or angle that is not overly generic or commonly phrased, while remaining accessible without specialized knowledge.'
	},
	{
		id: 'response_invitation',
		weight: 0.3,
		ideal:
			'The question naturally invites reflection and diverse perspectives, fostering curiosity and connection without prescriptive framing or implying a single correct answer.'
	}
];

export const articleCriteria: ScoringCriterion[] = [
	{
		id: 'content_alignment',
		weight: 0.35,
		ideal:
			"The summary accurately represents the article's main ideas and naturally incorporates the provided tags to enhance understanding."
	},
	{
		id: 'expositional_clarity',
		weight: 0.3,
		ideal:
			'The summary is well-organized, accessible, and free of jargon or grammatical errors, with ideas flowing logically to support learning.'
	},
	{
		id: 'reader_orientation',
		weight: 0.2,
		ideal:
			'The summary provides enough context and clarity to help readers discover whether this topic aligns with their interests or curiosity.'
	},
	{
		id: 'intellectual_engagement',
		weight: 0.15,
		ideal:
			'The summary sparks curiosity by highlighting interesting findings or questions without sensationalism, inviting further exploration.'
	}
];

export const eventImageCaptionPrompt = (event: Event) => {
	return `Write a concise caption describing what is visible in the image and how it relates to the event.

Event: "${event.name}"
Description: ${event.description.substring(0, 400)}
Activities: ${eventActivitiesList(event).join(', ')}

Guidelines:
- Describe observable elements in the image and their connection to the event in great detail
- Use concrete details rather than general statements
- Avoid promotional or generic language
- Focus on what can be seen in the image and how it reflects the event's theme or activities
- Mention at least one specific activity from the list if visible
- Keep the caption under 150 words`;
};

export const eventImageCriteria = (event: Event) =>
	[
		{
			id: 'context_alignment',
			weight: 0.4,
			ideal: `People participating in the activities (${eventActivitiesList(event).join(', ')}) with visible details showing how it relates to the event. `
		},
		{
			id: 'descriptive_specificity',
			weight: 0.25,
			ideal: `The caption references concrete, observable details rather than vague or generic descriptions.`
		},
		{
			id: 'linguistic_precision',
			weight: 0.15,
			ideal: `The caption is concise, clearly written, and avoids clichés or filler phrases.`
		},
		{
			id: 'event_reflection',
			weight: 0.1,
			ideal: `The caption effectively connects the visual elements to the event's theme or activities, enhancing understanding of the event.`
		},
		{
			id: 'activity_mention',
			weight: 0.1,
			ideal: `The caption mentions at least one specific activity from the event's activities list if it is visible in the image.`
		}
	] as ScoringCriterion[];

// User Profile Photo

const profileModel = '@cf/bytedance/stable-diffusion-xl-lightning';

export type UserProfilePromptData = {
	username: string;
	bio: string;
	created_at: string;
	visibility: typeof ocean.com.earthapp.Visibility.prototype.name;
	country: string;
	full_name: string;
	activities: Array<{
		name: string;
		description: string;
		types: (typeof ocean.com.earthapp.activity.ActivityType.prototype.name)[];
		aliases: string[];
	}>;
};

export const userProfilePhotoPrompt = (data: UserProfilePromptData) => {
	return {
		prompt: `
		Generate a heavily expressive, abstract, artistic, colorful, vibrant, and unique profile picture for a user with the username "${data.username}."
		The profile picture should be a special representation of the user as a whole, so include lots of vibrant colors and effects in every corner.
		The photo should be around inanimate objects or attributes, avoiding things like people or animals, or symbols that represent them (like toys or paintings.)

		The style of the profile picture should be in a flat, colorful, painting-like tone and style. Whatever you choose, make sure it is vibrant and colorful.
        There should be no text, logos, or any other elements that could be considered as a watermark or branding. The primary object should be placed in the
        center of the image. The background should be a simple, abstract design that complements the primary object without distracting from it.
        The object should be easily recognizable and visually appealing, with a focus on the colors and shapes rather than intricate details.

		For more information about the user, here is the user's biography:
		"${data.bio}"

        They created their account on ${data.created_at}. They have set their account visibility to ${data.visibility}.
		The user lives in ${data.country}. Their name is "${data.full_name ?? 'No name provided.'}".

		Lastly, the like the following activities:
		${data.activities.map(
			(activity) =>
				`- ${activity.name} (aka ${activity.aliases.join(', ')}): ${
					activity.description
						? activity.description.substring(0, 140)
						: 'No description available.'
				}\nIt is categorized as '${activity.types.join(', ')}.'\n`
		)}

		If any field says "None Provided" or "Unknown," disregard that element as apart of the profile picture, as the user has omitted said details.
		`.trim(),
		negative_prompt: `Avoid elements of toys, scary elements, political or sensitive statements, words, or any branding.`,
		guidance: 7.5
	} satisfies AiTextToImageInput;
};

export async function generateProfilePhoto(
	data: UserProfilePromptData,
	ai: Ai
): Promise<Uint8Array> {
	const profile = await ai.run(profileModel, userProfilePhotoPrompt(data));

	const reader = profile.getReader();
	const chunks: Uint8Array[] = [];
	let done = false;

	while (!done) {
		const { value, done: readerDone } = await reader.read();
		done = readerDone;
		if (value) {
			chunks.push(value);
		}
	}

	const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const imageBytes = new Uint8Array(totalLength);
	let offset = 0;
	for (const chunk of chunks) {
		imageBytes.set(chunk, offset);
		offset += chunk.length;
	}

	return imageBytes;
}

// Badge Mastery

// step types the badge-mastery AI is allowed to emit; mirrors `MASTERY_STEP_TYPES` in
// `src/user/badges/mastery.ts`; kept as a local string[] so we avoid a circular import
const MASTERY_AI_STEP_TYPES = [
	'draw_picture',
	'article_quiz',
	'take_photo_validation',
	'take_photo_classification',
	'transcribe_audio',
	'describe_text',
	'match_terms',
	'order_items',
	'article_read_time',
	'activity_read_time'
] as const;

type AIMasteryStepType = (typeof MASTERY_AI_STEP_TYPES)[number];

// raw shape emitted by the AI: a flat object with a `type` discriminator and type-specific optional fields
export type AIMasteryStep = {
	type: AIMasteryStepType;
	description: string;
	reward?: number;
	prompt?: string;
	threshold?: number;
	label?: string;
	activity_type?: string;
	min_length?: number;
	minutes?: number;
	items?: string[];
	pairs?: [string, string][];
};

export type MasteryValidationContext = {
	badge: Pick<Badge, 'id' | 'name' | 'description' | 'rarity' | 'tracker_id'>;
	stepCount: number;
	stepRewardCap: number;
	allowedLabels: string[];
	allowedActivityTypes: ActivityType[];
};

export function badgeMasteryAiSchema(stepCount: number) {
	return {
		type: 'object',
		required: ['steps'],
		properties: {
			steps: {
				type: 'array',
				minItems: stepCount,
				maxItems: stepCount,
				items: {
					type: 'object',
					required: ['type', 'description'],
					properties: {
						type: { type: 'string', enum: [...MASTERY_AI_STEP_TYPES] },
						description: { type: 'string', maxLength: 240 },
						reward: { type: 'number' },
						prompt: { type: 'string', maxLength: 260 },
						threshold: { type: 'number' },
						label: { type: 'string', maxLength: 50 },
						activity_type: { type: 'string', maxLength: 50 },
						min_length: { type: 'number' },
						minutes: { type: 'number' },
						items: {
							type: 'array',
							maxItems: 12,
							items: { type: 'string', maxLength: 80 }
						},
						pairs: {
							type: 'array',
							maxItems: 12,
							items: {
								type: 'array',
								minItems: 2,
								maxItems: 2,
								items: { type: 'string', maxLength: 80 }
							}
						}
					}
				}
			}
		}
	};
}

function badgeEarnedByPhrase(badge: MasteryValidationContext['badge']): string {
	const tracker = badge.tracker_id;
	if (!tracker) {
		return `${badge.description}.`;
	}
	switch (tracker) {
		case 'activities_added':
			return 'adding activities to your profile';
		case 'impact_points_earned':
			return 'earning impact points across the app';
		case 'prompts_responded':
			return 'responding to community prompts';
		case 'events_created':
			return 'creating events';
		case 'articles_read':
			return 'reading articles';
		case 'articles_read_time':
			return 'spending time reading articles';
		case 'prompts_read':
			return 'reading community prompts';
		case 'prompts_read_time':
			return 'spending time with community prompts';
		case 'events_attended':
			return 'attending events';
		case 'prompts_created':
			return 'creating community prompts';
		case 'event_images_submitted':
			return 'submitting photos to events';
		case 'event_images_submitted_good':
			return 'submitting high-quality event photos';
		case 'friends_added':
			return 'building your friends network';
		case 'article_quizzes_completed':
			return 'completing article quizzes';
		case 'article_quizzes_completed_perfect_score':
			return 'acing article quizzes';
		case 'event_types_attended':
			return 'attending events of multiple kinds';
		case 'event_countries_photographed':
			return 'photographing events around the world';
		case 'activity_read_time':
			return 'spending time exploring activities';
		default:
			// Defensive fallback if a new BadgeTracker is added without a case above.
			return `the ${String(tracker).replace(/_/g, ' ')} milestone`;
	}
}

export const badgeMasterySystemMessage = `
You design personalised "Badge Mastery" challenges — a short follow-up quest a user undertakes after earning a specific badge.

TASK: Generate exactly N step objects in JSON that reinforce the activity that earned the badge AND draw on the user's interests.

REQUIREMENTS:
- Output VALID JSON only matching the provided schema: { "steps": [ ... ] }
- Each step is a flat object with a "type" field and additional type-specific fields.
- Do NOT include alternative-step arrays — emit a flat list of single steps.
- description (<= 220 chars): clear, instructional, written in the second person. Do NOT reference the badge by name.
- reward (integer, optional): per-step bonus impact points; will be clamped server-side.
- Vary the step types — repeating the same type more than twice in a row is forbidden.

TYPE-SPECIFIC FIELDS:
- draw_picture: prompt (subject to draw, 1-12 words), threshold (0.55-0.7).
- article_quiz: activity_type (one of the allowed values), threshold (0.6-1.0 — required quiz percentage).
- article_read_time: activity_type (allowed value), minutes (5-30 integer).
- activity_read_time: activity_type (allowed value), minutes (5-30 integer).
- take_photo_classification: label (one of the allowed values), threshold (0.5-0.8).
- take_photo_validation: prompt (1-2 sentences describing what the photo should show), threshold (0.5-0.75).
- transcribe_audio: prompt (1-2 sentences describing what the user should say aloud), threshold (0.55-0.8).
- describe_text: prompt (1-2 sentences asking for written reflection), threshold (0.5-0.75), min_length (50-300 integer characters).
- match_terms: prompt (1 sentence instruction), pairs (array of 4-8 [term, description] pairs related to the badge theme).
- order_items: items (array of 4-8 short labels in the correct order, e.g. chronological, size, intensity).

CONSTRAINTS:
- Do not fabricate activity_type values or classification labels — pick from the provided allowlists.
- Do not include real geographic coordinates, real people's names, or links.
- Steps must be completable solo, in any order indicated, without third-party services.
`;

export function badgeMasteryUserPrompt(
	user: UserProfilePromptData,
	ctx: MasteryValidationContext
): string {
	const activitiesSummary =
		user.activities.length > 0
			? user.activities
					.slice(0, 6)
					.map(
						(a) =>
							`- ${a.name}${a.aliases?.length ? ` (aka ${a.aliases.slice(0, 3).join(', ')})` : ''}: ${
								a.description ? a.description.substring(0, 120) : 'No description.'
							}`
					)
					.join('\n')
			: '- (no activities provided)';

	return `Badge being mastered
- Name: ${ctx.badge.name}
- Description: ${ctx.badge.description}
- Rarity: ${ctx.badge.rarity}
- Earned by: ${badgeEarnedByPhrase(ctx.badge)}

User profile
- Username: ${user.username || 'unknown'}
- Country: ${user.country || 'unknown'}
- Bio: ${user.bio ? user.bio.substring(0, 280) : '(none)'}
- Account visibility: ${user.visibility}
- Activities they like:
${activitiesSummary}

Allowlists
- Allowed activity_type values: ${ctx.allowedActivityTypes.join(', ')}
- Allowed labels for take_photo_classification: ${ctx.allowedLabels.join(', ')}

Generate exactly ${ctx.stepCount} steps that personalise the mastery challenge for this user.
Anchor each step to BOTH the badge's theme (${badgeEarnedByPhrase(ctx.badge)}) and at least one of the user's listed activities or interests.
Per-step reward cap: ${ctx.stepRewardCap} impact points.

Return JSON only.`;
}

// Convert a clamped AI step into a fully-formed QuestStep. Returns null if the step's
// type-specific fields are too malformed to produce a usable QuestStep.
function clampMasteryStep(step: AIMasteryStep, ctx: MasteryValidationContext): QuestStep | null {
	if (typeof step !== 'object' || step === null) return null;
	if (
		typeof step.type !== 'string' ||
		!MASTERY_AI_STEP_TYPES.includes(step.type as AIMasteryStepType)
	) {
		return null;
	}

	const description =
		typeof step.description === 'string' && step.description.trim().length > 0
			? step.description.trim().slice(0, 240)
			: null;
	if (!description) return null;

	const cappedReward =
		typeof step.reward === 'number' && Number.isFinite(step.reward)
			? Math.max(0, Math.min(Math.round(step.reward), ctx.stepRewardCap))
			: undefined;

	const allowedActivityTypeSet = new Set(ctx.allowedActivityTypes as string[]);
	const allowedLabelSet = new Set(ctx.allowedLabels);

	switch (step.type) {
		case 'draw_picture': {
			const prompt =
				typeof step.prompt === 'string' && step.prompt.trim().length > 0
					? step.prompt.trim().slice(0, 120)
					: null;
			if (!prompt) return null;
			const threshold = clampNumber(step.threshold, 0.55, 0.7, 0.6);
			return {
				type: 'draw_picture',
				description,
				parameters: [prompt, threshold],
				...(cappedReward !== undefined ? { reward: cappedReward } : {})
			};
		}
		case 'article_quiz': {
			const at =
				typeof step.activity_type === 'string' ? step.activity_type.trim().toUpperCase() : '';
			if (!allowedActivityTypeSet.has(at)) return null;
			const threshold = clampNumber(step.threshold, 0.6, 1.0, 0.8);
			return {
				type: 'article_quiz',
				description,
				parameters: [at as ActivityType, threshold],
				...(cappedReward !== undefined ? { reward: cappedReward } : {})
			};
		}
		case 'article_read_time': {
			const at =
				typeof step.activity_type === 'string' ? step.activity_type.trim().toUpperCase() : '';
			if (!allowedActivityTypeSet.has(at)) return null;
			const minutes = clampInt(step.minutes, 5, 30, 10);
			return {
				type: 'article_read_time',
				description,
				parameters: [at as ActivityType, minutes * 60],
				...(cappedReward !== undefined ? { reward: cappedReward } : {})
			};
		}
		case 'activity_read_time': {
			const at =
				typeof step.activity_type === 'string' ? step.activity_type.trim().toUpperCase() : '';
			if (!allowedActivityTypeSet.has(at)) return null;
			const minutes = clampInt(step.minutes, 5, 30, 10);
			return {
				type: 'activity_read_time',
				description,
				parameters: [{ type: 'activity_type', value: at as ActivityType }, minutes * 60],
				...(cappedReward !== undefined ? { reward: cappedReward } : {})
			};
		}
		case 'take_photo_classification': {
			const label =
				typeof step.label === 'string' ? step.label.trim().toLowerCase().replace(/\s+/g, '_') : '';
			if (!allowedLabelSet.has(label)) return null;
			const threshold = clampNumber(step.threshold, 0.5, 0.8, 0.6);
			return {
				type: 'take_photo_classification',
				description,
				parameters: [label, threshold],
				...(cappedReward !== undefined ? { reward: cappedReward } : {})
			};
		}
		case 'take_photo_validation': {
			const prompt =
				typeof step.prompt === 'string' && step.prompt.trim().length > 0
					? step.prompt.trim().slice(0, 200)
					: null;
			if (!prompt) return null;
			const threshold = clampNumber(step.threshold, 0.5, 0.75, 0.6);
			return {
				type: 'take_photo_validation',
				description,
				parameters: [prompt, threshold],
				...(cappedReward !== undefined ? { reward: cappedReward } : {})
			};
		}
		case 'transcribe_audio': {
			const prompt =
				typeof step.prompt === 'string' && step.prompt.trim().length > 0
					? step.prompt.trim().slice(0, 240)
					: null;
			if (!prompt) return null;
			const threshold = clampNumber(step.threshold, 0.55, 0.8, 0.7);
			return {
				type: 'transcribe_audio',
				description,
				parameters: [prompt, threshold],
				...(cappedReward !== undefined ? { reward: cappedReward } : {})
			};
		}
		case 'describe_text': {
			const prompt =
				typeof step.prompt === 'string' && step.prompt.trim().length > 0
					? step.prompt.trim().slice(0, 240)
					: null;
			if (!prompt) return null;
			const threshold = clampNumber(step.threshold, 0.5, 0.75, 0.6);
			const minLength = clampInt(step.min_length, 50, 300, 100);
			// Server-built criteria — AI-emitted criteria are never trusted because the
			// shape is intricate (weights must sum to 1) and mis-shaped input crashes the
			// scorer in `src/content/ferry.ts`.
			const criteria: ScoringCriterion[] = [
				{
					id: 'relevance',
					weight: 0.5,
					ideal: `The response directly addresses: ${prompt}`
				},
				{
					id: 'depth',
					weight: 0.3,
					ideal:
						'The response is thoughtful and shows substantive detail rather than a one-line answer.'
				},
				{
					id: 'originality',
					weight: 0.2,
					ideal: "The response is in the user's own voice and includes specific examples."
				}
			];
			return {
				type: 'describe_text',
				description,
				parameters: [criteria, threshold, minLength],
				...(cappedReward !== undefined ? { reward: cappedReward } : {})
			};
		}
		case 'match_terms': {
			const prompt =
				typeof step.prompt === 'string' && step.prompt.trim().length > 0
					? step.prompt.trim().slice(0, 200)
					: 'Match each item to its description.';
			const pairsRaw = Array.isArray(step.pairs) ? step.pairs : [];
			const pairs: [string, string][] = [];
			for (const p of pairsRaw) {
				if (!Array.isArray(p) || p.length !== 2) continue;
				const [a, b] = p;
				if (typeof a !== 'string' || typeof b !== 'string') continue;
				const a2 = a.trim().slice(0, 80);
				const b2 = b.trim().slice(0, 80);
				if (a2 && b2) pairs.push([a2, b2]);
				if (pairs.length >= 8) break;
			}
			if (pairs.length < 4) return null;
			return {
				type: 'match_terms',
				description,
				parameters: [prompt, pairs],
				...(cappedReward !== undefined ? { reward: cappedReward } : {})
			};
		}
		case 'order_items': {
			const itemsRaw = Array.isArray(step.items) ? step.items : [];
			const items: string[] = [];
			for (const it of itemsRaw) {
				if (typeof it !== 'string') continue;
				const it2 = it.trim().slice(0, 80);
				if (it2) items.push(it2);
				if (items.length >= 8) break;
			}
			if (items.length < 4) return null;
			return {
				type: 'order_items',
				description,
				parameters: [items],
				...(cappedReward !== undefined ? { reward: cappedReward } : {})
			};
		}
		default:
			return null;
	}
}

function injectMasteryDelays(steps: QuestStep[]): QuestStep[] {
	if (steps.length === 0) return steps;
	const cutover = Math.ceil(steps.length / 2);
	return steps.map((step, idx) => (idx >= cutover ? { ...step, delay: 24 * 60 * 60 } : step));
}

export function validateBadgeMasterySteps(
	raw: unknown,
	ctx: MasteryValidationContext
): QuestStep[] {
	if (typeof raw !== 'object' || raw === null) {
		throw new Error('Badge mastery generation returned a non-object payload.');
	}

	const stepsRaw = (raw as { steps?: unknown }).steps;
	if (!Array.isArray(stepsRaw)) {
		throw new Error('Badge mastery generation payload is missing a `steps` array.');
	}

	const clamped: QuestStep[] = [];
	for (const candidate of stepsRaw) {
		if (clamped.length >= ctx.stepCount) break;
		const clean = clampMasteryStep(candidate as AIMasteryStep, ctx);
		if (clean) clamped.push(clean);
	}

	if (clamped.length < ctx.stepCount) {
		throw new Error(
			`Badge mastery generation produced ${clamped.length} valid steps; ${ctx.stepCount} required.`
		);
	}

	return injectMasteryDelays(clamped);
}
