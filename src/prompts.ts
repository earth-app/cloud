import * as ocean from '@earth-app/ocean';
import { Bindings, OceanArticle } from './types';
import { Ai } from '@cloudflare/workers-types';

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
		...options
	};

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
			.replace(/["'"'""`]/g, '') // Remove fancy quotes and backticks
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
				preserveBasicPunctuation: true
			});
			// Additional description-specific cleaning
			cleaned = cleaned
				.replace(/^(This activity|This is|It is|This involves)\s*/i, '')
				.replace(/\s+(involves|is about|consists of)\s+/gi, ' ')
				.replace(/em dash/g, ',');
			break;

		case 'title':
			cleaned = sanitizeAIOutput(cleaned, {
				removeQuotes: true,
				removeMarkdown: true,
				removeExtraWhitespace: true,
				removeBrackets: true,
				preserveBasicPunctuation: true
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
				preserveBasicPunctuation: false
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
				preserveBasicPunctuation: true
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
				preserveBasicPunctuation: true
			});
			// Ensure proper question format
			if (!cleaned.endsWith('?') && !cleaned.endsWith('.')) {
				cleaned += '?';
			}
			break;
	}

	return cleaned.trim();
}

export function validateActivityDescription(description: string, activityName: string): string {
	try {
		if (!description || typeof description !== 'string') {
			logAIFailure('ActivityDescription', activityName, description, 'Invalid response type');
			throw new Error(`Failed to generate valid description for activity: ${activityName}`);
		}

		// Sanitize the description first
		const sanitized = sanitizeForContentType(description, 'description');

		const cleaned = sanitized.trim();
		const wordCount = cleaned.split(/\s+/).length;

		if (cleaned.length < 50) {
			logAIFailure(
				'ActivityDescription',
				activityName,
				cleaned,
				`Description too short: ${cleaned.length} chars`
			);
			throw new Error(`Generated description too short for activity: ${activityName}`);
		}

		if (wordCount > 300) {
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

		return cleaned;
	} catch (error) {
		// If validation fails, we fail closed with a safe fallback
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

export function validateActivityTags(tagsResponse: string, activityName: string): string[] {
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
			return tags.slice(0, 5);
		}

		return tags;
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

		if (wordCount > 3) {
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

		if (wordCount > 10) {
			logAIFailure('ArticleTitle', originalTitle, title, `Title too long: ${wordCount} words`);
			throw new Error('Generated article title too long');
		}

		// Check for remaining unwanted formatting after sanitization
		if (title.includes('"') || title.includes('```') || title.includes('*')) {
			logAIFailure('ArticleTitle', originalTitle, title, 'Contains unwanted formatting');
			throw new Error('Generated article title contains invalid formatting');
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

		if (summary.length < 100) {
			logAIFailure(
				'ArticleSummary',
				originalTitle,
				summary,
				`Summary too short: ${summary.length} chars`
			);
			throw new Error('Generated article summary too short');
		}

		if (wordCount > 400) {
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

		if (wordCount > 15) {
			logAIFailure('PromptQuestion', 'N/A', question, `Too many words: ${wordCount}`);
			throw new Error('Generated prompt question too long');
		}

		// Check for prohibited phrases
		const prohibited = ['what if', 'imagine', 'you', 'your', 'i ', 'my ', 'we ', 'our '];
		const lowerQuestion = question.toLowerCase();

		for (const phrase of prohibited) {
			if (lowerQuestion.includes(phrase)) {
				logAIFailure('PromptQuestion', 'N/A', question, `Contains prohibited phrase: ${phrase}`);
				throw new Error('Generated prompt question contains prohibited phrase');
			}
		}

		return question;
	} catch (error) {
		logAIFailure('PromptQuestion', 'N/A', questionResponse, `Validation failed: ${error}`);
		throw error; // Re-throw since prompts need to be valid
	}
}

// Activity Prompts

export const activityDescriptionSystemMessage = `
You are an expert in describing activities to a general audience.

TASK: Generate a single paragraph description of the given activity.

REQUIREMENTS:
- Length: 150-250 words (approximately 200-350 tokens)
- Format: Single paragraph, no bullet points, quotes, or special formatting
- Tone: Informative yet lighthearted, engaging and accessible
- Language: Simple, clear, avoid jargon
- Content: Include practical benefits and interesting facts
- No emojis, special characters, or markdown formatting

OUTPUT FORMAT: Return only the description text, nothing else.
`;

export const activityDescriptionPrompt = (activity: string): string => {
	return `Describe the activity: "${activity}"

Focus on:
- What the activity involves
- Why people enjoy it
- Benefits or interesting aspects
- How accessible it is to beginners

Write in an engaging, friendly tone that makes the activity sound appealing.`;
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
	'perserverance',
	'mental health',
	'mathematics',
	'physics',
	'psychology',
	'reading',
	'writing',
	'engineering',
	'biology',
	'chemistry',
	'climate change',
	'astronomy',
	'music',
	'artificial intelligence',
	'robotics',
	'data science',
	'meditation',
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
	'economics',
	'education'
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
- Length: 150-300 words
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
- Length: 150-300 words
- Tone: Informative yet approachable
- When including the tags, integrate them naturally into the text in a way that makes sense contextually`;
};

// Prompts Prompts

export const promptsSystemMessage = `
Current date: ${new Date().toISOString().split('T')[0]}

TASK: Generate exactly ONE original, thought-provoking question.

REQUIREMENTS:
- Length: Under 15 words, under 100 characters
- Format: End with '?' if appropriate
- Style: Open-ended (not yes/no), clear, grammatically correct
- Content: Timeless, insightful, engaging, creative
- Language: Simple English, maximum one comma
- Avoid: Personal pronouns, "what if", "imagine", clichés, company names, specific events

EXAMPLES OF GOOD QUESTIONS:
- "What drives people to take creative risks?"
- "How does curiosity shape learning?"
- "Why do some habits stick while others fade?"

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
	'In'
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
	'perserverance',
	'integrity',
	'mental health',
	'financial literacy',
	'work-life balance',
	'remote work',
	'hydration',
	'nutrition',
	'meditation',
	'energy',
	'resilience',
	'curiosity',
	'open-mindedness',
	'critical thinking',
	'emotional intelligence'
];

export const promptsQuestionPrompt = () => {
	const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
	const topic = topics[Math.floor(Math.random() * topics.length)];

	return `Create a question with the prefix '${prefix}' about '${topic}' that is open-ended, engaging, and thought-provoking.`;
};

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
		guidance: 35
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

export async function getProfilePhoto(id: bigint, bindings: Bindings): Promise<Uint8Array> {
	if (id === 1n) {
		const resp = await bindings.ASSETS.fetch('https://assets.local/cloud.png');
		const fallback = await resp!.arrayBuffer();
		return new Uint8Array(fallback);
	}

	const profileImage = `users/${id}/profile.png`;

	const obj = await bindings.R2.get(profileImage);
	if (obj) {
		const buf = await obj.arrayBuffer();
		return new Uint8Array(buf);
	}

	const resp = await bindings.ASSETS.fetch('https://assets.local/earth-app.png');
	const fallback = await resp!.arrayBuffer();
	return new Uint8Array(fallback);
}

export async function newProfilePhoto(data: UserProfilePromptData, id: bigint, bindings: Bindings) {
	const profileImage = `users/${id}/profile.png`;
	const profile = await generateProfilePhoto(data, bindings.AI);
	await bindings.R2.put(profileImage, profile, {
		httpMetadata: { contentType: 'image/png' }
	});

	return profile;
}
