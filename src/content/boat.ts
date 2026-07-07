// boat - ai content generation

import { com } from '@earth-app/ocean';

import {
	Activity,
	Article,
	Bindings,
	Event,
	EventData,
	ExecutionCtxLike,
	OceanArticle
} from '../util/types';
import * as prompts from '../util/ai';
import { isPlaceBirthdaySource } from '../util/ai';
import { chunkArray, batchProcess } from '../util/util';
import { toOrdinal, splitContent, stripMarkdownCodeFence, getSynonyms } from '../util/lang';
import { runAI, extractAIText } from '../util/ai-runtime';
import {
	Entry,
	ExactDateEntry,
	ExactDateWithYearEntry,
	getAllEntries,
	getEntriesInNextWeeks
} from '@earth-app/moho';
import {
	extractLocationFromEventName,
	parseBirthdayEventName,
	uploadPlaceThumbnail
} from './thumbnails';
import { retrieveActivities } from '../util/mantle2';
import type { QuestStep } from '../user/quests';
import type { Badge } from '../user/badges';
import { activityTypeNames, badgeTier, labelsForBadge, masterySpec } from '../user/badges/mastery';

export const descriptionModel = '@cf/meta/llama-4-scout-17b-16e-instruct';
export const tagsModel = '@cf/meta/llama-3.1-8b-instruct-fp8';
export const articleTopicModel = '@cf/meta/llama-3.2-3b-instruct';
export const rankerModel = '@cf/baai/bge-reranker-base';
export const articleModel = '@cf/mistralai/mistral-small-3.1-24b-instruct';
export const quizModel = '@cf/meta/llama-4-scout-17b-16e-instruct';
export const promptModel = '@cf/openai/gpt-oss-120b';
export const badgeMasteryModel = '@cf/google/gemma-4-26b-a4b-it';

export async function createActivityData(id: string, activity: string, ai: Ai) {
	try {
		let desc: string | null = null;
		let lastError: Error | null = null;
		const maxRetries = 3;
		const temperatureRamp = [0.2, 0.5, 0.8];

		for (let attempt = 1; attempt <= maxRetries; attempt++) {
			try {
				console.log(`Generating activity description, attempt ${attempt}/${maxRetries}`);

				const description = await ai.run(descriptionModel, {
					messages: [
						{ role: 'system', content: prompts.activityDescriptionSystemMessage.trim() },
						{ role: 'user', content: prompts.activityDescriptionPrompt(activity).trim() }
					],
					max_tokens: 512,
					temperature: temperatureRamp[attempt - 1]
				});

				const rawDesc = description?.response || '';
				// Validate with throwOnFailure=true to enable retry logic
				desc = prompts.validateActivityDescription(rawDesc, activity, true);

				// If we got here, validation succeeded
				console.log(`Activity description generated successfully on attempt ${attempt}`);
				break;
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));
				console.warn(
					`Activity description attempt ${attempt}/${maxRetries} failed:`,
					lastError.message
				);

				if (attempt === maxRetries) {
					console.error('All attempts to generate valid activity description failed', {
						activity,
						desc,
						error: lastError
					});
				}
			}
		}

		if (!desc) {
			throw new Error(
				`Failed to generate valid description for activity "${activity}" after ${maxRetries} attempts: ${lastError?.message}`
			);
		}

		// Generate tags with error handling
		let tagsResult;
		try {
			tagsResult = await ai.run(tagsModel, {
				messages: [
					{ role: 'system', content: prompts.activityTagsSystemMessage.trim() },
					{ role: 'user', content: `'${activity}'` }
				]
			});
		} catch (aiError) {
			console.error('AI model failed for activity tags', { activity, error: aiError });
			// Continue with default tags rather than failing completely
			tagsResult = { response: 'OTHER' };
		}

		const tags = prompts.validateActivityTags(tagsResult?.response || '', activity);

		// Find aliases
		let aliases: string[] = [];
		const synonyms = await getSynonyms(activity);
		if (synonyms && synonyms.length > 0) {
			aliases.push(
				...synonyms
					.map((syn) => syn.trim().toLowerCase())
					.filter((syn) => syn.length > 0 && syn !== activity)
					.filter((syn) => !syn.includes(' ')) // no multi-word aliases
					.slice(0, 5) // limit to 5 aliases
			);
		}

		// Find icon
		const preferredSets = [
			'mdi',
			'material-symbols',
			'material-symbols-light',
			'carbon',
			'lucide',
			'ph',
			'cib',
			'carbon',
			'solar',
			'heroicons',
			'map',
			'circum',
			'nimbus'
		]; // preferred icon sets in order

		const searchUrl = `https://api.iconify.design/search?query=${encodeURIComponent(activity)}&prefixes=${preferredSets.join(',')}`;
		let icon = await fetch(searchUrl)
			.then(async (res) => res.json<{ icons: string[]; total: number }>())
			.then((data) => {
				if (data.total === 0) return null;

				// Prefer icons that contain "round" or "rounded"
				const iconsAll = data?.icons || [];
				const isRounded = (id: string) => /(^|[-_:])(?:round|rounded)(?=($|[-_:]))/i.test(id);

				for (const set of preferredSets) {
					const found = iconsAll.find((icon) => icon.startsWith(set + ':') && isRounded(icon));
					if (found) return found;
				}

				const anyRounded = iconsAll.find((icon) => isRounded(icon));
				if (anyRounded) return anyRounded;
				const icons = data?.icons || [];

				for (const set of preferredSets) {
					const found = icons.find((icon) => icon.startsWith(set + ':'));
					if (found) return found;
				}

				return icons[0]; // fallback to first icon if no preferred set found
			});

		const activityData = {
			id: id,
			name: id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
			types: tags,
			description: desc,
			aliases: aliases,
			fields: {} as { [key: string]: string }
		} satisfies Activity;

		if (icon) {
			activityData.fields.icon = icon;
		}

		return activityData;
	} catch (error) {
		console.error('Error creating activity data:', error);
		throw new Error(
			`Activity data creation failed: ${error instanceof Error ? error.message : 'Unknown error'}`
		);
	}
}

// Article Endpoints

export async function findArticle(bindings: Bindings): Promise<[OceanArticle[], string[]]> {
	const ai = bindings.AI as Ai;

	let topicRaw;
	try {
		topicRaw = await ai.run(articleTopicModel, {
			messages: [
				{ role: 'system', content: prompts.articleTopicSystemMessage.trim() },
				{ role: 'user', content: prompts.articleTopicPrompt().trim() }
			],
			max_tokens: 12,
			temperature: 0.3 // moderate temperature for topic diversity
		});
	} catch (aiError) {
		console.error('AI model failed for article topic generation', { error: aiError });
		throw new Error('Failed to generate article topic using AI model');
	}

	const topic = prompts.validateArticleTopic(topicRaw?.response || '');
	console.debug('Generated article topic:', topic);

	const tagCount = Math.floor(Math.random() * 3) + 3; // Randomly select 3 to 5 tags (fixed Math.random calculation)
	const tags = com.earthapp.activity.ActivityType.values()
		.filter((t) => t !== com.earthapp.activity.ActivityType.OTHER)
		.sort(() => Math.random() - 0.5)
		.slice(0, tagCount)
		.map((t) =>
			t.name
				.replace(/_/g, ' ')
				.toLowerCase()
				.replace(/\b\w/g, (c) => c.toUpperCase())
				.trim()
		);

	// Search for articles on the topic
	const searchResults = await findArticles(topic, bindings, 2);
	if (!searchResults || searchResults.length === 0) {
		throw new Error('No articles found for topic: ' + topic);
	}

	// Rank articles to find the best one
	// Limit is ~512 tokens per context for BGE-Reranker
	// Filter aggressively first, then chunk by 150 articles for optimal throughput
	const filteredResults = searchResults
		.filter(
			(article) =>
				(article.abstract && article.abstract.length >= 250) ||
				(article.content && article.content.length >= 250)
		) // must have abstract or content with at least 250 characters
		.filter((article) => article.title.match(/[^\x00-\x7F]+/gim)?.length || 0 === 0) // title must be only ascii
		.filter((article) => article.keywords && article.keywords.length > 0); // must have keywords

	const batches = chunkArray(filteredResults, 150);

	const allArticles: { text: string; ocean: OceanArticle }[] = [];
	const rankQuery = prompts.articleClassificationQuery(topic, tags);
	const allRanked: { id: number; score: number }[] = [];

	for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
		const batch = batches[batchIndex];
		const batchOffset = batchIndex * 150; // Track offset for index mapping

		const contexts = batch.map((article) => ({
			text:
				(article.title || '') +
				' by ' +
				(article.author || 'Unknown') +
				' | Tags: ' +
				(article.keywords || []).slice(0, 8).join(', ') + // limit keywords to reduce tokens
				'\n' +
				(article.abstract || '').substring(0, 180),
			ocean: article // store original for later retrieval
		}));
		allArticles.push(...contexts);

		// Rank this batch
		const ranked = await ai.run(rankerModel, {
			query: rankQuery,
			contexts: contexts.map((c) => ({ text: c.text })) // remove 'ocean' field for ranking
		});

		if (!ranked || !ranked.response) {
			throw new Error('Failed to rank articles: ' + JSON.stringify(ranked));
		}

		// Map batch-relative IDs to global indices
		allRanked.push(
			...ranked.response
				.filter((r) => r.id !== undefined)
				.map((r) => ({ id: r.id! + batchOffset, score: r.score || 0 }))
		);
	}

	// select top ranked + bottom ranked for maximum diversity
	const sortedByScore = allRanked.sort((a, b) => b.score - a.score);
	const top1 = sortedByScore.slice(0, 1);
	const bottom1 = sortedByScore.slice(-1);
	const selectedIndices = [...top1.map((r) => r.id), ...bottom1.map((r) => r.id)];
	const selectedArticles: OceanArticle[] = [];

	for (const idx of selectedIndices) {
		if (idx < 0 || idx >= allArticles.length) {
			throw new Error(`Invalid article index: ${idx} (array length: ${allArticles.length})`);
		}
		const article = allArticles[idx].ocean;
		if (!article) {
			throw new Error('Article data not found: index ' + idx);
		}
		selectedArticles.push(article);
	}

	// Sanitize keywords and clean selected articles
	for (const article of selectedArticles) {
		const keywords: string[] = [];
		for (const kw of article.keywords || []) {
			if (keywords.length >= 25) break;
			const cleaned = kw.trim().split(/\. +/g);
			for (const c of cleaned) {
				if (keywords.length >= 25) break;
				const c2 = c.trim();
				if (c2.length > 0 && c2.length < 35 && !keywords.includes(c2)) {
					keywords.push(c2);
				}
			}
		}
		if ((article as any).type) {
			delete (article as any).type;
		}
		if (article.favicon && !article.favicon.startsWith('http')) {
			delete article.favicon;
		}
	}

	return [selectedArticles, tags];
}

let HAS_PUBMED_API_KEY = false;
export async function findArticles(
	query: string,
	bindings: Bindings,
	pageLimit: number = 1
): Promise<OceanArticle[]> {
	if (!HAS_PUBMED_API_KEY && bindings.NCBI_API_KEY) {
		com.earthapp.ocean.boat.Scraper.setApiKey('PubMed', bindings.NCBI_API_KEY);
		HAS_PUBMED_API_KEY = true;
	}

	const query0 = query.replace(/\+/g, ' ').replace(/[^a-zA-Z0-9\s]/g, '');

	const res = await com.earthapp.ocean.boat.searchAllAsPromise(
		com.earthapp.ocean.boat.Scraper.Companion,
		query0,
		pageLimit
	);
	const results = res
		.asJsReadonlyArrayView()
		.map(async (item) => JSON.parse(item.toJson()) satisfies OceanArticle);

	return await batchProcess(results);
}

export async function createArticle(
	ocean: OceanArticle,
	ai: Ai,
	tags: string[]
): Promise<Omit<Article, 'id' | 'author' | 'author_id' | 'created_at' | 'color_hex'>> {
	const maxContentLength = 100000;
	const articleContent =
		ocean.content?.trim()?.substring(0, maxContentLength) || ocean.abstract?.trim() || '';

	if (!articleContent) {
		throw new Error('No content available for article generation');
	}

	try {
		let titleResult;
		try {
			titleResult = await ai.run(articleModel, {
				messages: [
					{ role: 'system', content: prompts.articleTitlePrompt(ocean, tags).trim() },
					{ role: 'user', content: ocean.title.trim() }
				],
				// 48 tokens can truncate a 10-word title once leading whitespace/quotes are accounted for.
				max_tokens: 80,
				temperature: 0.2 // lower temperature for focused titles
			});
		} catch (aiError) {
			console.error('AI model failed for article title generation', {
				title: ocean.title,
				error: aiError
			});
			throw new Error('Failed to generate article title using AI model');
		}

		const title = prompts.validateArticleTitle(titleResult?.response || '', ocean.title);

		let summaryResult;
		try {
			summaryResult = await ai.run(articleModel, {
				messages: [
					{ role: 'system', content: prompts.articleSystemMessage.trim() },
					{ role: 'user', content: articleContent },
					{ role: 'user', content: prompts.articleSummaryPrompt(ocean, tags).trim() }
				],
				max_tokens: 1536,
				temperature: 0.25 // balanced for natural writing while maintaining focus
			});
		} catch (aiError) {
			console.error('AI model failed for article summary generation', {
				title: ocean.title,
				error: aiError
			});
			throw new Error('Failed to generate article summary using AI model');
		}

		const summary = prompts.validateArticleSummary(summaryResult?.response || '', ocean.title);
		const formattedSummary = splitContent(summary).join('\n\n');

		return {
			ocean,
			tags,
			title: title,
			description: summary.substring(0, 256) + '...',
			color: ocean.theme_color || '#ffffff',
			content: formattedSummary
		};
	} catch (error) {
		console.error('Error creating article:', error);
		throw new Error(
			`Article creation failed: ${error instanceof Error ? error.message : 'Unknown error'}`
		);
	}
}

export type ArticleQuizQuestion = {
	question: string;
} & (
	| {
			type: 'multiple_choice';
			options: string[];
			correct_answer?: string;
			correct_answer_index: number;
	  }
	| {
			type: 'multi_select';
			options: string[];
			correct_answers?: string[];
			correct_answer_indices: number[];
	  }
	| {
			type: 'true_false';
			options: ('True' | 'False')[] | [];
			correct_answer?: 'True' | 'False';
			correct_answer_index: number | -1;
			is_true: boolean;
			is_false: boolean;
	  }
	| {
			// items[] is the canonical correct order; the cloud shuffles before serving to clients
			type: 'order';
			items: string[];
	  }
);

const QUIZ_CUTOFF = 300;

export async function createArticleQuiz(
	article: Pick<Article, 'title' | 'content' | 'ocean' | 'tags'>,
	ai: Ai
): Promise<ArticleQuizQuestion[]> {
	try {
		// the AI-generated summary is the primary basis for the quiz; the raw scientific
		// source is supporting context that a minority of questions may draw on
		const summary = (article.content || '').trim();
		const sourceRaw = (article.ocean?.content || article.ocean?.abstract || '').trim();
		if (!summary && !sourceRaw) {
			console.warn('createArticleQuiz: no usable content for article, skipping');
			return [];
		}

		// the source can be very long, so window it like before; the summary is already concise
		const source =
			sourceRaw.length > QUIZ_CUTOFF * 2
				? sourceRaw.substring(0, QUIZ_CUTOFF) +
					'... (truncated) ...' +
					sourceRaw.substring(sourceRaw.length - QUIZ_CUTOFF)
				: sourceRaw;

		const messages: { role: string; content: string }[] = [
			{ role: 'system', content: prompts.articleQuizSystemMessage.trim() },
			{
				role: 'user',
				content:
					'ARTICLE SUMMARY (primary source — most questions must come from here):\n' +
					(summary || '(no summary available; base the quiz on the source material below)')
			}
		];

		if (source) {
			messages.push({
				role: 'user',
				content:
					'SOURCE MATERIAL (supporting context — only a minority of questions may draw on details unique to it):\n' +
					source
			});
		}

		messages.push({
			role: 'user',
			content:
				prompts.articleQuizPrompt.trim() +
				'\n\nReturn ONLY a JSON object of the form {"questions": [ ... ]}. No markdown, no prose.'
		});

		// bounded retry so a transient miss or a malformed json blob gets another schema-constrained
		// pass before we fall back; extractAIText tolerates both `.response` and chat-completions shapes
		const quizResult = (await runAI(
			'createArticleQuiz',
			() =>
				ai.run(quizModel, {
					messages,
					max_tokens: 4096, // room for up to 10 questions without truncating the JSON
					temperature: 0.3
				} as any),
			{
				attempts: 3,
				perAttemptTimeoutMs: 15000,
				totalTimeoutMs: 40000,
				// treat an unparseable / empty quiz as retryable so we re-ask before giving up
				shouldRetryResult: (v) => {
					const parsed = coerceQuizResult(
						extractAIText(v) || (v as { response?: unknown })?.response
					);
					return !parsed || !Array.isArray(parsed.questions) || parsed.questions.length === 0;
				}
			}
		)) as { response?: unknown };

		const parsedResult = coerceQuizResult(
			extractAIText(quizResult) || (quizResult as { response?: unknown })?.response
		);
		if (!parsedResult) {
			console.error('createArticleQuiz: model returned no usable quiz', {
				responseType: typeof quizResult?.response,
				resultKeys: quizResult ? Object.keys(quizResult) : null
			});
			return [];
		}

		const quizData = (parsedResult.questions || []) as ArticleQuizQuestion[];
		return sanitizeQuizQuestions(quizData);
	} catch (error) {
		console.error('Quiz generation failed, continuing without quiz:', error);
		return []; // Return empty quiz rather than failing article creation
	}
}

// "all/none/both of the above"-style options give the answer away — reject them.
const GIVEAWAY_OPTION =
	/\b(all|none|both)\s+of\s+(the\s+)?(above|following|these|those|options|choices)\b/i;

// a quiz holds 4-10 questions; the model is told the range, this is the hard ceiling (mantle2 also rejects >10)
const MAX_QUIZ_QUESTIONS = 10;
// answers (options / order items) must stay short and readable; we reject an over-long
// answer rather than trimming it, since truncating with an ellipsis would mangle the meaning
const ANSWER_MAX_CHARS = 128;

function answersWithinLimit(values: unknown): boolean {
	if (!Array.isArray(values)) return true;
	return values.every((v) => typeof v !== 'string' || v.length <= ANSWER_MAX_CHARS);
}

function sanitizeQuizQuestions(questions: ArticleQuizQuestion[]): ArticleQuizQuestion[] {
	const cleaned: ArticleQuizQuestion[] = [];

	for (const q of questions) {
		if (!q || typeof q !== 'object' || typeof q.question !== 'string') continue;

		if (q.type === 'order') {
			if (!answersWithinLimit(q.items)) continue;
			cleaned.push(q);
			continue;
		}

		if (q.type !== 'multi_select') {
			// multiple_choice / true_false: drop the question if any answer overflows
			if (!answersWithinLimit((q as { options?: unknown }).options)) continue;
			cleaned.push(q);
			continue;
		}

		const options = Array.isArray(q.options) ? q.options : [];
		const correct = new Set(
			Array.isArray(q.correct_answer_indices) ? q.correct_answer_indices : []
		);

		// keep non-empty, non-giveaway options and remap old → new indices
		const keptOptions: string[] = [];
		const remap = new Map<number, number>();
		for (let i = 0; i < options.length; i++) {
			const opt = options[i];
			if (typeof opt !== 'string' || !opt.trim() || GIVEAWAY_OPTION.test(opt)) continue;
			remap.set(i, keptOptions.length);
			keptOptions.push(opt);
		}

		const newIndices = [...correct]
			.filter((i) => remap.has(i))
			.map((i) => remap.get(i)!)
			.sort((a, b) => a - b);

		// need a genuine multi-answer question: 3+ options, 2+ correct, at least one incorrect
		if (
			keptOptions.length < 3 ||
			newIndices.length < 2 ||
			newIndices.length >= keptOptions.length ||
			!answersWithinLimit(keptOptions)
		) {
			continue;
		}

		cleaned.push({
			...q,
			options: keptOptions,
			correct_answer_indices: newIndices,
			correct_answers: newIndices.map((i) => keptOptions[i])
		});
	}

	return cleaned.slice(0, MAX_QUIZ_QUESTIONS);
}

function coerceQuizResult(response: unknown): { questions?: ArticleQuizQuestion[] } | null {
	if (response && typeof response === 'object') {
		return response as { questions?: ArticleQuizQuestion[] };
	}
	if (typeof response !== 'string' || !response.trim()) return null;

	const cleaned = stripMarkdownCodeFence(response);
	try {
		return JSON.parse(cleaned);
	} catch {
		const start = cleaned.indexOf('{');
		const end = cleaned.lastIndexOf('}');
		if (start < 0 || end <= start) return null;
		try {
			return JSON.parse(cleaned.slice(start, end + 1));
		} catch {
			return null;
		}
	}
}

export async function recommendArticles(
	pool: Article[],
	activities: string[],
	limit: number,
	ai: Ai
): Promise<Article[]> {
	if (pool.length === 0 || activities.length === 0) {
		throw new Error('No articles or activities provided for recommendation');
	}

	// Fallback: return random articles from pool
	const getRandomArticles = () => {
		const shuffled = [...pool].sort(() => Math.random() - 0.5);
		return shuffled.slice(0, Math.min(limit, pool.length));
	};

	try {
		const rankQuery = prompts.articleRecommendationQuery(activities);
		const contexts = pool.map((article) => ({
			text:
				(article.title || '') +
				' | Tags: ' +
				(article.tags && Array.isArray(article.tags) ? article.tags.slice(0, 6).join(', ') : '') + // limit tags to reduce tokens with null check
				'\n' +
				(article.description || '').substring(0, 400), // slightly reduce description length
			original: article // store original for later retrieval
		}));

		const ranked = await ai.run(rankerModel, {
			query: rankQuery,
			contexts: contexts.map((c) => ({ text: c.text })) // remove 'original' field for ranking
		});

		if (!ranked || !ranked.response) {
			console.warn('AI ranking failed, using random fallback');
			return getRandomArticles();
		}

		const allRanked: { id: number; score: number }[] = ranked.response
			.filter((r) => r.id !== undefined)
			.map((r) => ({ id: r.id!, score: r.score || 0 }));

		// Get top N articles based on score, filtering by minimum threshold
		const scoreThreshold = 0.3; // only include articles with meaningful relevance
		let topRanked = allRanked
			.filter((r) => r.score >= scoreThreshold && r.id >= 0 && r.id < contexts.length) // bounds check
			.sort((a, b) => b.score - a.score)
			.slice(0, limit)
			.map((r) => contexts[r.id].original);

		// If no articles meet threshold, relax it
		if (topRanked.length === 0) {
			topRanked = allRanked
				.filter((r) => r.id >= 0 && r.id < contexts.length)
				.sort((a, b) => b.score - a.score)
				.slice(0, limit)
				.map((r) => contexts[r.id].original);

			// If still empty, use random fallback
			if (topRanked.length === 0) {
				console.warn('No ranked articles found, using random fallback');
				return getRandomArticles();
			}
		}

		return topRanked;
	} catch (error) {
		console.error('Error in recommendArticles:', error);
		return getRandomArticles();
	}
}

export async function recommendSimilarArticles(
	article: Article,
	pool: Article[],
	limit: number,
	ai: Ai
) {
	if (pool.length === 0) {
		throw new Error('No articles provided for recommendation');
	}

	// Fallback: return random articles from pool (excluding original)
	const getRandomArticles = () => {
		const filtered = pool.filter((a) => a.id !== article.id);
		const shuffled = [...filtered].sort(() => Math.random() - 0.5);
		return shuffled.slice(0, Math.min(limit, filtered.length));
	};

	try {
		const rankQuery = prompts.articleSimilarityQuery(article);
		const contexts = pool.map((a) => ({
			text:
				(a.title || '') +
				' | Tags: ' +
				(a.tags && Array.isArray(a.tags) ? a.tags.slice(0, 6).join(', ') : '') + // limit tags with null check
				'\n' +
				(a.content || '').substring(0, 400), // reduce content length
			original: a // store original for later retrieval
		}));

		const ranked = await ai.run(rankerModel, {
			query: rankQuery,
			contexts: contexts.map((c) => ({ text: c.text })) // remove 'original' field for ranking
		});

		if (!ranked || !ranked.response) {
			console.warn('AI ranking failed, using random fallback');
			return getRandomArticles();
		}

		const allRanked: { id: number; score: number }[] = ranked.response
			.filter((r) => r.id !== undefined)
			.map((r) => ({ id: r.id!, score: r.score || 0 }));

		// Get top N similar articles based on score with minimum threshold
		const scoreThreshold = 0.4; // higher threshold for similarity recommendations
		let topRanked = allRanked
			.filter((r) => r.score >= scoreThreshold && r.id >= 0 && r.id < contexts.length) // bounds check
			.sort((a, b) => b.score - a.score)
			.slice(0, limit)
			.map((r) => contexts[r.id].original);

		let filtered = topRanked.filter((a) => a.id !== article.id); // exclude the original article

		// If no articles meet threshold, relax it
		if (filtered.length === 0) {
			filtered = allRanked
				.filter((r) => r.id >= 0 && r.id < contexts.length)
				.sort((a, b) => b.score - a.score)
				.slice(0, limit)
				.map((r) => contexts[r.id].original)
				.filter((a) => a.id !== article.id);

			// If still empty, use random fallback
			if (filtered.length === 0) {
				console.warn('No similar articles found, using random fallback');
				return getRandomArticles();
			}
		}

		return filtered;
	} catch (error) {
		console.error('Error in recommendSimilarArticles:', error);
		return getRandomArticles();
	}
}

// Prompt Endpoints

export async function createPrompt(ai: Ai) {
	// each attempt draws a fresh random prefix/topic and re-validates, so a single refusal or
	// off-spec generation doesn't fail the (hourly) cron run
	const maxRetries = 3;
	let lastError: Error | null = null;

	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		let gen: {
			output: {
				id: string;
				content: {
					text: string;
					type: 'output_text' | 'reasoning_text';
				}[];
				type: 'message' | 'reasoning';
			}[];
		} | null = null;

		try {
			gen = await ai.run(promptModel as any, {
				instructions: prompts.promptsSystemMessage.trim(),
				input: prompts.promptsQuestionPrompt().trim(),
				reasoning: {
					effort: 'medium',
					summary: 'concise'
				}
			});
		} catch (aiError) {
			lastError = aiError instanceof Error ? aiError : new Error(String(aiError));
			console.warn(
				`Prompt generation attempt ${attempt}/${maxRetries} failed (model error):`,
				lastError.message
			);
			continue;
		}

		try {
			if (!gen || !gen.output || gen.output.length === 0) {
				throw new Error('Failed to generate prompt: empty response');
			}

			const message = gen.output.find((o) => o.type === 'message');
			if (!message) {
				throw new Error('No valid prompt message found in response');
			}

			const rawPromptText = message.content
				.find((c) => c.type === 'output_text')
				?.text?.trim()
				?.replace(/\n/g, ' ');

			return prompts.validatePromptQuestion(rawPromptText || '');
		} catch (validationError) {
			lastError =
				validationError instanceof Error ? validationError : new Error(String(validationError));
			console.warn(
				`Prompt generation attempt ${attempt}/${maxRetries} produced an invalid question:`,
				lastError.message
			);
		}
	}

	console.error(`Failed to generate a valid prompt after ${maxRetries} attempts`, {
		error: lastError?.message
	});
	// surface the most recent specific failure so callers/logs keep the actionable reason
	throw lastError ?? new Error('Failed to generate prompt');
}

export async function rankActivitiesForEvent(
	eventName: string,
	eventDescription: string,
	activitiesPool: Activity[],
	ai: Ai,
	limit: number = 2
): Promise<string[]> {
	if (activitiesPool.length === 0) {
		console.warn('No activities provided for ranking');
		return [];
	}

	const rankQuery = prompts.eventActivitySelectionQuery(eventName, eventDescription);
	const contexts = activitiesPool.map((activity) => ({
		text: `${activity.name} - ${activity.description.substring(0, 200)}`,
		original: activity
	}));

	let ranked;
	try {
		ranked = await ai.run(rankerModel, {
			query: rankQuery,
			contexts: contexts.map((c) => ({ text: c.text }))
		});
	} catch (err) {
		// ranked activities are supplementary; a ranker hiccup must not abort event creation
		console.warn('Failed to rank activities for event; continuing without ranked activities', {
			eventName,
			error: err instanceof Error ? err.message : String(err)
		});
		return [];
	}

	if (!ranked || !ranked.response) {
		console.warn('Failed to rank activities for event');
		return [];
	}

	const allRanked: { id: number; score: number }[] = ranked.response
		.filter((r) => r.id !== undefined)
		.map((r) => ({ id: r.id!, score: r.score || 0 }));

	// Filter by score threshold (0.5 or higher indicates good relevance)
	const scoreThreshold = 0.5;
	const topRanked = allRanked
		.filter((r) => r.score >= scoreThreshold && r.id >= 0 && r.id < contexts.length) // bounds check
		.sort((a, b) => b.score - a.score)
		.slice(0, limit)
		.map((r) => contexts[r.id].original.id);

	return topRanked;
}

type UpcomingCalendarEntries = ReturnType<typeof getEntriesInNextWeeks>;

export async function retrieveEvents(): Promise<UpcomingCalendarEntries> {
	const candidateRoots = ['/bundle/data', 'bundle/data', './bundle/data'];

	for (const root of candidateRoots) {
		try {
			const allEntries = getAllEntries(root);
			return getEntriesInNextWeeks(allEntries, 2);
		} catch {
			// Try the next candidate path.
		}
	}

	console.warn('Failed to retrieve event calendar data from bundle paths', {
		candidateRoots
	});
	return [];
}

function isValidEntryMonthDay(month: number, day: number): boolean {
	if (!Number.isInteger(month) || !Number.isInteger(day)) {
		return false;
	}
	if (month < 1 || month > 12 || day < 1 || day > 31) {
		return false;
	}

	// Keep leap-day anniversaries valid; moho resolves these to Mar 1 on non-leap years.
	if (month === 2 && day === 29) {
		return true;
	}

	const maxDay = new Date(2025, month, 0).getDate();
	return day <= maxDay;
}

function getInvalidEntryMonthDay(entry: Entry): { month: number; day: number } | null {
	if (!(entry instanceof ExactDateEntry) && !(entry instanceof ExactDateWithYearEntry)) {
		return null;
	}

	if (!isValidEntryMonthDay(entry.month, entry.day)) {
		return { month: entry.month, day: entry.day };
	}

	return null;
}

export async function createEvent(
	entry: Entry,
	date: Date,
	bindings: Bindings
): Promise<EventData | null> {
	let name = entry.name;
	if (!name) {
		console.warn('Event entry has no name, skipping event creation', { entry });
		return null;
	}

	const invalidMonthDay = getInvalidEntryMonthDay(entry);
	if (invalidMonthDay) {
		console.warn('Event entry has invalid month/day in source data, skipping event creation', {
			name,
			source: entry.source,
			month: invalidMonthDay.month,
			day: invalidMonthDay.day
		});
		return null;
	}

	if (isNaN(date.getTime())) {
		console.warn('Event entry has invalid date, skipping event creation', {
			name,
			date
		});
		return null;
	}

	const ai = bindings.AI;
	const root = bindings.MANTLE_URL || 'https://api.earth-app.com';
	const id = `${name}-${date.toISOString()}`;

	// check if exists based on moho_id
	const searchUrl = `${root}/v2/events?search=${encodeURIComponent(id)}`;
	const searchRes = await fetch(searchUrl, {
		method: 'GET',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${bindings.ADMIN_API_KEY}`
		}
	});

	if (searchRes.ok) {
		const searchData = await searchRes.json<{ total: number }>();
		if (searchData.total > 0) {
			console.log(`Event already exists for moho_id=${id}, skipping creation`);
			return null;
		}
	} else {
		const errorText = await searchRes.text();
		console.error(
			`Failed to search for existing event: ${searchRes.status} ${searchRes.statusText} - ${errorText}`
		);
	}

	// Format birthday titles with ordinal numbers
	if (entry instanceof ExactDateWithYearEntry) {
		const parsedBirthdayName = parseBirthdayEventName(name);
		const yearsSince = entry.getYearsSince(date);
		if (parsedBirthdayName && yearsSince > 0) {
			const possessive = parsedBirthdayName.possessive || "'s";
			name = `${parsedBirthdayName.rawLocationName}${possessive} ${toOrdinal(yearsSince)} Birthday`;
		}
	}

	const eventKind = prompts.classifyEventEntry(entry);

	// retry generation+validation so a transient model error or a truncated/short description
	// doesn't abort the whole event; fall back to the deterministic description as a last resort
	let validatedDescription: string | null = null;
	let lastDescError: unknown = null;
	const descTemperatureRamp = [0.2, 0.4, 0.6];

	for (let attempt = 1; attempt <= descTemperatureRamp.length; attempt++) {
		try {
			const descriptionResult = await ai.run(descriptionModel, {
				messages: [
					{ role: 'system', content: prompts.eventDescriptionSystemMessage.trim() },
					{
						role: 'user',
						content: prompts.eventDescriptionPrompt(entry, date).trim()
					}
				],
				// headroom so descriptions aren't truncated mid-sentence (truncation fails the
				// end-punctuation check in validateEventDescription)
				max_tokens: 700,
				temperature: descTemperatureRamp[attempt - 1]
			});

			// throwOnFailure=true so a short/truncated/refusal description retries instead of
			// silently falling back on the first attempt
			validatedDescription = prompts.validateEventDescription(
				descriptionResult?.response || '',
				name,
				true,
				entry
			);
			break;
		} catch (descError) {
			lastDescError = descError;
			console.warn(
				`Event description attempt ${attempt}/${descTemperatureRamp.length} failed for "${name}":`,
				descError instanceof Error ? descError.message : String(descError)
			);
		}
	}

	if (validatedDescription === null) {
		console.error('All attempts to generate a valid event description failed; using fallback', {
			name,
			error: lastDescError instanceof Error ? lastDescError.message : String(lastDescError)
		});
		// throwOnFailure=false returns the deterministic per-kind fallback description
		validatedDescription = prompts.validateEventDescription('', name, false, entry);
	}

	let tagsResult;
	try {
		tagsResult = await ai.run(tagsModel, {
			messages: [
				{ role: 'system', content: prompts.activityTagsSystemMessage.trim() },
				{ role: 'user', content: `'${name}'` }
			]
		});
	} catch (aiError) {
		console.error('AI model failed for activity tags', { name, error: aiError });
		// Continue with default tags rather than failing completely
		tagsResult = { response: 'OTHER' };
	}

	// Fetch and rank activities from the API
	const activitiesPool = await retrieveActivities(bindings);
	const rankedActivityIds = await rankActivitiesForEvent(
		name,
		validatedDescription,
		activitiesPool,
		ai,
		2 // Get top 2 activities
	);

	// Combine activity types and ranked activity IDs
	const activities = [
		...prompts.validateActivityTags(tagsResult?.response || '', name),
		...rankedActivityIds
	];

	const event = {
		name,
		description: validatedDescription,
		type: 'ONLINE',
		date: date.getTime(),
		end_date: date.getTime() + 24 * 60 * 60 * 1000, // 24 hours later
		visibility: 'PUBLIC',
		activities,
		fields: {
			moho_id: id,
			moho_source: entry.source || '',
			moho_kind: eventKind
		}
	} satisfies EventData;

	return event;
}

export async function recommendEvents(
	pool: Event[],
	activities: string[],
	limit: number,
	ai: Ai
): Promise<Event[]> {
	if (pool.length === 0 || activities.length === 0) {
		throw new Error('No events or activities provided for recommendation');
	}

	// Fallback: return random events from pool
	const getRandomEvents = () => {
		const shuffled = [...pool].sort(() => Math.random() - 0.5);
		return shuffled.slice(0, Math.min(limit, pool.length));
	};

	try {
		const rankQuery = prompts.eventRecommendationQuery(activities);

		const contexts = pool.map((event) => {
			// Extract activity names/types from EventActivity objects
			const activityStrings = (event.activities || []).map((a) => {
				if (a.type === 'activity_type') {
					return a.value;
				} else {
					return a.name || '';
				}
			});

			return {
				text:
					(event.name || '') +
					' | Activities: ' +
					activityStrings.slice(0, 5).join(', ') + // limit activities
					'\n' +
					(event.description || '').substring(0, 400), // reduce description
				original: event
			};
		});

		const ranked = await ai.run(rankerModel, {
			query: rankQuery,
			contexts: contexts.map((c) => ({ text: c.text })) // remove 'original' field for ranking
		});

		if (!ranked || !ranked.response) {
			console.warn('AI ranking failed, using random fallback');
			return getRandomEvents();
		}

		const allRanked: { id: number; score: number }[] = ranked.response
			.filter((r) => r.id !== undefined)
			.map((r) => ({ id: r.id!, score: r.score || 0 }));

		// Get top N events based on score with minimum relevance threshold
		const scoreThreshold = 0.3;
		let topRanked = allRanked
			.filter((r) => r.score >= scoreThreshold && r.id >= 0 && r.id < contexts.length) // bounds check
			.sort((a, b) => b.score - a.score)
			.slice(0, limit)
			.map((r) => contexts[r.id].original)
			.sort((a, b) => {
				let weight = 0;

				// prioritize events hosted with account type WRITER or ORGANIZER
				if (a.host || b.host) {
					const aHostType = a.host?.account_type || '';
					const bHostType = b.host?.account_type || '';
					if (aHostType === 'WRITER' || aHostType === 'ORGANIZER') weight -= 1;
					if (bHostType === 'WRITER' || bHostType === 'ORGANIZER') weight += 1;
				}

				// prioritize events with more activities
				const aActivities = a.activities ? a.activities.length : 0;
				const bActivities = b.activities ? b.activities.length : 0;
				if (aActivities > bActivities) weight -= 1;
				else if (bActivities > aActivities) weight += 1;

				// prioritize events that are sooner / end sooner
				if (a.date < b.date) weight -= 1;
				else if (b.date < a.date) weight += 1;

				if (a.end_date || b.end_date) {
					const aEnd = a.end_date || a.date;
					const bEnd = b.end_date || b.date;
					if (aEnd < bEnd) weight -= 1;
					else if (bEnd < aEnd) weight += 1;
				}

				return weight;
			});

		// If no events meet threshold, relax it
		if (topRanked.length === 0) {
			topRanked = allRanked
				.filter((r) => r.id >= 0 && r.id < contexts.length)
				.sort((a, b) => b.score - a.score)
				.slice(0, limit)
				.map((r) => contexts[r.id].original);

			// If still empty, use random fallback
			if (topRanked.length === 0) {
				console.warn('No ranked events found, using random fallback');
				return getRandomEvents();
			}
		}

		return topRanked;
	} catch (error) {
		console.error('Error in recommendEvents:', error);
		return getRandomEvents();
	}
}

export async function recommendSimilarEvents(event: Event, pool: Event[], limit: number, ai: Ai) {
	if (pool.length === 0) {
		throw new Error('No events provided for recommendation');
	}

	// Fallback: return random events from pool (excluding original)
	const getRandomEvents = () => {
		const filtered = pool.filter((e) => e.name !== event.name);
		const shuffled = [...filtered].sort(() => Math.random() - 0.5);
		return shuffled.slice(0, Math.min(limit, filtered.length));
	};

	try {
		// Convert event to EventData format for the query
		const eventData: EventData = {
			name: event.name,
			description: event.description,
			type: event.type,
			date: event.date,
			end_date: event.end_date,
			visibility: event.visibility,
			activities: event.activities.map((a) => {
				if (a.type === 'activity_type') {
					return a.value;
				} else {
					return a.id || a.name || '';
				}
			}),
			fields: event.fields
		};

		const rankQuery = prompts.eventSimilarityQuery(eventData);
		const contexts = pool.map((e) => {
			// Extract activity names/types from EventActivity objects
			const activityStrings = (e.activities || []).map((a) => {
				if (a.type === 'activity_type') {
					return a.value;
				} else {
					return a.name || '';
				}
			});

			return {
				text:
					(e.name || '') +
					' | Activities: ' +
					activityStrings.slice(0, 5).join(', ') + // limit activities
					'\n' +
					(e.description || '').substring(0, 400), // reduce description
				original: e
			};
		});

		const ranked = await ai.run(rankerModel, {
			query: rankQuery,
			contexts: contexts.map((c) => ({ text: c.text })) // remove 'original' field for ranking
		});

		if (!ranked || !ranked.response) {
			console.warn('AI ranking failed, using random fallback');
			return getRandomEvents();
		}

		const allRanked: { id: number; score: number }[] = ranked.response
			.filter((r) => r.id !== undefined)
			.map((r) => ({ id: r.id!, score: r.score || 0 }));

		// Get top N similar events based on score with higher threshold for similarity
		const scoreThreshold = 0.4;
		let topRanked = allRanked
			.filter((r) => r.score >= scoreThreshold && r.id >= 0 && r.id < contexts.length) // bounds check
			.sort((a, b) => b.score - a.score)
			.slice(0, limit)
			.map((r) => contexts[r.id].original);

		let filtered = topRanked.filter((e) => e.name !== event.name); // exclude the original event

		// If no events meet threshold, relax it
		if (filtered.length === 0) {
			filtered = allRanked
				.filter((r) => r.id >= 0 && r.id < contexts.length)
				.sort((a, b) => b.score - a.score)
				.slice(0, limit)
				.map((r) => contexts[r.id].original)
				.filter((e) => e.name !== event.name);

			// If still empty, use random fallback
			if (filtered.length === 0) {
				console.warn('No similar events found, using random fallback');
				return getRandomEvents();
			}
		}

		return filtered;
	} catch (error) {
		console.error('Error in recommendSimilarEvents:', error);
		return getRandomEvents();
	}
}

// Badge Mastery - on-demand AI generation of a personalised quest after a badge is earned.
export async function generateBadgeMasterySteps(
	badge: Badge,
	user: prompts.UserProfilePromptData,
	bindings: Bindings
): Promise<(QuestStep | QuestStep[])[]> {
	const spec = masterySpec(badge.rarity);
	const tier = badgeTier(badge);
	const tierForCtx = tier
		? {
				tierIndex: tier.tierIndex,
				totalTiers: tier.totalTiers,
				easier: tier.siblings
					.slice(0, tier.tierIndex)
					.map((b) => ({ name: b.name, description: b.description })),
				harder: tier.siblings
					.slice(tier.tierIndex + 1)
					.map((b) => ({ name: b.name, description: b.description }))
			}
		: null;
	const ctx: prompts.MasteryValidationContext = {
		badge: {
			id: badge.id,
			name: badge.name,
			description: badge.description,
			rarity: badge.rarity,
			tracker_id: badge.tracker_id
		},
		stepCount: spec.stepCount,
		stepRewardCap: spec.stepRewardCap,
		minAltGroups: spec.minAltGroups,
		maxAltsPerGroup: spec.maxAltsPerGroup,
		allowedLabels: labelsForBadge(badge),
		allowedActivityTypes: activityTypeNames(),
		tier: tierForCtx
	};

	const ai = bindings.AI;
	// gemma-4 returns the openai chat-completions shape; legacy bindings return `response`
	type GemmaResult = {
		response?: string;
		choices?: {
			finish_reason?: string;
			message?: { content?: string | null; reasoning?: string | null };
		}[];
	};
	let result: GemmaResult;
	try {
		// json_schema response_format lets the model enforce step shape upfront
		result = (await ai.run(
			badgeMasteryModel as any,
			{
				messages: [
					{ role: 'system', content: prompts.badgeMasterySystemMessage.trim() },
					{ role: 'user', content: prompts.badgeMasteryUserPrompt(user, ctx).trim() }
				],
				// alts roughly multiply payload size by group factor; keep headroom over reasoning + 2x output
				max_tokens: 12288,
				reasoning_effort: 'low',
				temperature: 0.45,
				response_format: {
					type: 'json_schema',
					json_schema: {
						name: 'badge_mastery_quest',
						schema: prompts.badgeMasteryAiSchema(spec.stepCount, spec.maxAltsPerGroup),
						// openai strict mode would require additionalProperties:false on every
						// nested object; the schema is intentionally permissive (validate clamps)
						strict: false
					}
				}
			} as any
		)) as GemmaResult;
	} catch (aiError) {
		console.error('AI model failed for badge mastery generation', {
			badgeId: badge.id,
			error: aiError
		});
		throw new Error('Failed to generate badge mastery quest using AI model', { cause: aiError });
	}

	const rawText =
		typeof result?.response === 'string'
			? result.response
			: typeof result?.choices?.[0]?.message?.content === 'string'
				? result.choices[0]!.message!.content!
				: '';

	if (!rawText.trim()) {
		// finish_reason='length' + null content means reasoning ate the entire token budget
		const finishReason = result?.choices?.[0]?.finish_reason;
		console.error('Badge mastery generation returned an empty response', {
			badgeId: badge.id,
			finishReason,
			resultKeys: result ? Object.keys(result) : null,
			snippet: JSON.stringify(result).slice(0, 400)
		});
		throw new Error(
			`Badge mastery generation returned an empty response (finish_reason=${finishReason ?? 'unknown'}).`
		);
	}

	const cleaned = stripMarkdownCodeFence(rawText);

	let parsed: unknown;
	try {
		parsed = JSON.parse(cleaned);
	} catch (parseErr) {
		console.error('Badge mastery JSON parse failed', {
			badgeId: badge.id,
			snippet: cleaned.substring(0, 200),
			error: parseErr
		});
		throw new Error('Badge mastery generation returned invalid JSON.');
	}

	// throws if not enough steps survive clamping
	return prompts.validateBadgeMasterySteps(parsed, ctx);
}

export async function postEvent(
	event: Awaited<ReturnType<typeof createEvent>>,
	bindings: Bindings,
	ctx: ExecutionCtxLike
) {
	if (!event) {
		throw new Error('No event data to post');
	}

	if (!event.name || !event.description) {
		throw new Error('Event must have name and description');
	}

	const root = bindings.MANTLE_URL || 'https://api.earth-app.com';

	const url = `${root}/v2/events`;
	const res = await fetch(url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${bindings.ADMIN_API_KEY}`
		},
		body: JSON.stringify({
			...event,
			censor: true
		})
	});

	if (!res.ok) {
		const errorText = await res.text();
		throw new Error(`Failed to post event: ${res.status} ${res.statusText} - ${errorText}`);
	}

	let data: { id?: string | number; name?: string } & Record<string, unknown>;
	try {
		data = await res.json<{ id?: string | number; name?: string } & Record<string, unknown>>();
	} catch (err) {
		throw new Error(`Failed to parse event creation response: ${String(err)}`);
	}

	if (!data || data.id === undefined || data.id === null) {
		throw new Error(`Failed to create event, no ID returned: ${JSON.stringify(data)}`);
	}

	const eventIdRaw = String(data.id).trim();
	if (!/^\d+$/.test(eventIdRaw)) {
		console.warn('Skipping thumbnail generation: event ID is not numeric', {
			eventIdRaw,
			name: data.name
		});
		return data;
	}

	let eventId: bigint;
	try {
		eventId = BigInt(eventIdRaw);
	} catch (err) {
		console.error('Skipping thumbnail generation: event ID failed BigInt parsing', {
			eventIdRaw,
			name: data.name,
			err
		});
		return data;
	}

	if (eventId <= 0n) {
		console.error('Skipping thumbnail generation: event ID is zero or negative', {
			eventIdRaw,
			name: data.name,
			responseSnippet: JSON.stringify(data).slice(0, 300)
		});
		return data;
	}

	const persistedName = typeof data.name === 'string' ? data.name : '';
	const sourceName = event.name || '';
	const mohoKind = event.fields?.moho_kind;
	const mohoSource = event.fields?.moho_source;
	const isPlaceBirthday =
		mohoKind === 'place_birthday' || (!mohoKind && isPlaceBirthdaySource(mohoSource));

	const locationName = isPlaceBirthday
		? extractLocationFromEventName(persistedName) || extractLocationFromEventName(sourceName)
		: null;

	if (isPlaceBirthday && locationName) {
		console.log(
			`Generating thumbnail for place birthday event: ${locationName} (event ${eventIdRaw})`
		);
		try {
			const [image, author] = await uploadPlaceThumbnail(locationName, eventId, bindings, ctx);
			if (!image || image.length === 0) {
				console.warn('No thumbnail was generated for place birthday event', {
					eventId: eventIdRaw,
					locationName,
					persistedName,
					sourceName,
					mohoSource
				});
			} else {
				console.log(
					`Stored place birthday thumbnail for event ${eventIdRaw} (${locationName}): ${image.length} bytes, author=${author ?? 'Unknown'}`
				);
			}
		} catch (thumbnailErr) {
			console.error('Thumbnail generation failed for created event; continuing without thumbnail', {
				eventId: eventIdRaw,
				locationName,
				persistedName,
				sourceName,
				mohoSource,
				err: thumbnailErr
			});
		}
	} else if (isPlaceBirthday) {
		console.warn('Could not extract location from place birthday event name; skipping thumbnail', {
			eventId: eventIdRaw,
			persistedName,
			sourceName,
			mohoSource
		});
	} else {
		console.log(
			`Skipping thumbnail generation for non-place event: ${sourceName} (kind=${mohoKind || 'unknown'}, source=${mohoSource || 'unknown'})`
		);
	}

	return data;
}
