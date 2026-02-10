// boat - ai content generation

import { com } from '@earth-app/ocean';

import { Activity, Article, Bindings, Event, EventData, OceanArticle, Prompt } from '../util/types';
import { getSynonyms } from '../util/dictionary';
import * as prompts from '../util/ai';
import { Ai } from '@cloudflare/workers-types';
import {
	chunkArray,
	splitContent,
	stripMarkdownCodeFence,
	toOrdinal,
	uploadEventThumbnail,
	batchProcess
} from '../util/util';
import {
	Entry,
	ExactDateWithYearEntry,
	getAllEntries,
	getEntriesInNextWeeks
} from '@earth-app/moho';

const descriptionModel = '@cf/meta/llama-4-scout-17b-16e-instruct';
const tagsModel = '@cf/meta/llama-3.1-8b-instruct-fp8';
const articleTopicModel = '@cf/meta/llama-3.2-3b-instruct';
const rankerModel = '@cf/baai/bge-reranker-base';
const articleModel = '@cf/mistralai/mistral-small-3.1-24b-instruct';
const quizModel = '@cf/meta/llama-4-scout-17b-16e-instruct';
const promptModel = '@cf/openai/gpt-oss-120b';

const activityTagsSchema = {
	type: 'object',
	properties: {
		tags: {
			type: 'array',
			minItems: 1,
			maxItems: 5,
			items: {
				type: 'string',
				enum: com.earthapp.activity.ActivityType.values().map((t: any) => t.name.toUpperCase())
			}
		}
	},
	required: ['tags']
};

export async function createActivityData(id: string, activity: string, ai: Ai) {
	try {
		// Generate description with retry logic (3 attempts)
		let desc: string | null = null;
		let lastError: Error | null = null;
		const maxRetries = 5;

		for (let attempt = 1; attempt <= maxRetries; attempt++) {
			try {
				console.log(`Generating activity description, attempt ${attempt}/${maxRetries}`);

				const description = await ai.run(descriptionModel, {
					messages: [
						{ role: 'system', content: prompts.activityDescriptionSystemMessage.trim() },
						{ role: 'user', content: prompts.activityDescriptionPrompt(activity).trim() }
					],
					max_tokens: 512,
					temperature: 0.1 + (attempt - 1) * 0.05 // gentler temperature increase for faster convergence
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

export async function postActivity(bindings: Bindings, activity: Activity): Promise<Activity> {
	const url = `${bindings.MANTLE_URL || 'https://api.earth-app.com'}/v2/activities`;
	const res = await fetch(url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${bindings.ADMIN_API_KEY}`
		},
		body: JSON.stringify(activity)
	});

	if (!res.ok) {
		const errorText = await res.text();
		throw new Error(`Failed to post activity: ${res.status} ${res.statusText} - ${errorText}`);
	}

	const data = await res.json<Activity>();
	if (!data || !data.id) {
		throw new Error('Failed to create activity, no ID returned');
	}

	return data;
}

// Article Endpoints
export async function findArticle(bindings: Bindings): Promise<[OceanArticle, string[]]> {
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

	// Find highest-ranked article
	const best = allRanked.sort((a, b) => b.score - a.score)[0];
	if (!best) {
		throw new Error('No best article found after ranking: length ' + allRanked.length);
	}

	// Bounds check before accessing array
	if (best.id < 0 || best.id >= allArticles.length) {
		throw new Error(`Invalid article index: ${best.id} (array length: ${allArticles.length})`);
	}

	const bestArticle = allArticles[best.id].ocean;
	if (!bestArticle) {
		throw new Error('Best article data not found: index ' + best.id + ' of ' + allArticles.length);
	}

	// Sanitize keywords
	const keywords: string[] = [];
	for (const kw of bestArticle.keywords || []) {
		if (keywords.length >= 25) break;

		const cleaned = kw.trim().split(/\. +/g); // sometimes keywords are split by ". "
		for (const c of cleaned) {
			if (keywords.length >= 25) break;

			const c2 = c.trim();
			if (c2.length > 0 && c2.length < 35 && !keywords.includes(c2)) {
				keywords.push(c2);
			}
		}
	}

	// Remove 'type' tag from bestArticle
	if ((bestArticle as any).type) {
		delete (bestArticle as any).type;
	}

	// Remove invalid favicon URLs
	if (bestArticle.favicon && !bestArticle.favicon.startsWith('http')) {
		delete bestArticle.favicon;
	}

	return [bestArticle, tags];
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
				max_tokens: 48,
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
			type: 'true_false';
			options: ('True' | 'False')[] | [];
			correct_answer?: 'True' | 'False';
			correct_answer_index: number | -1;
			is_true: boolean;
			is_false: boolean;
	  }
);

const articleQuizAiSchema = {
	type: 'object',
	properties: {
		questions: {
			type: 'array',
			minItems: 2,
			maxItems: 5,
			items: {
				type: 'object',
				properties: {
					question: {
						type: 'string',
						maxLength: 100
					},
					type: { type: 'string', enum: ['multiple_choice', 'true_false'] },
					options: {
						type: 'array',
						maxItems: 4,
						items: {
							type: 'string',
							maxLength: 60
						}
					},
					correct_answer: { type: 'string' },
					correct_answer_index: { type: 'number' },
					is_true: { type: 'boolean' },
					is_false: { type: 'boolean' }
				},
				required: ['question', 'type', 'options', 'correct_answer', 'correct_answer_index']
			}
		}
	},
	required: ['questions']
};

const QUIZ_CUTOFF = 300;

export async function createArticleQuiz(
	article: Pick<Article, 'title' | 'content' | 'ocean' | 'tags'>,
	ai: Ai
): Promise<ArticleQuizQuestion[]> {
	try {
		const content = article.ocean.content || article.ocean.abstract || '';
		const firstPart = content.substring(0, QUIZ_CUTOFF);
		const lastPart = content.substring(content.length - QUIZ_CUTOFF);
		const quizResult = await ai.run(quizModel, {
			messages: [
				{ role: 'system', content: prompts.articleQuizSystemMessage.trim() },
				{
					role: 'user',
					content:
						content.length > QUIZ_CUTOFF * 2
							? firstPart + '... (truncated) ...' + lastPart
							: content
				},
				{ role: 'user', content: prompts.articleQuizPrompt.trim() }
			],
			max_tokens: 512,
			temperature: 0.3,
			response_format: {
				type: 'json_schema',
				json_schema: articleQuizAiSchema
			}
		});

		const responseText = stripMarkdownCodeFence(quizResult.response || '{"questions":[]}');
		const parsedResult = JSON.parse(responseText);
		const quizData = (parsedResult.questions || []) as ArticleQuizQuestion[];
		return quizData;
	} catch (error) {
		console.error('Quiz generation failed, continuing without quiz:', error);
		return []; // Return empty quiz rather than failing article creation
	}
}

export async function postArticle(
	article: Pick<Article, 'title' | 'description' | 'content' | 'ocean'>,
	quiz: ArticleQuizQuestion[] | null,
	bindings: Bindings
): Promise<Article> {
	const url = (bindings.MANTLE_URL || 'https://api.earth-app.com') + '/v2/articles';
	const res = await fetch(url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${bindings.ADMIN_API_KEY}`
		},
		body: JSON.stringify({
			...article,
			censor: true
		})
	});

	if (!res.ok) {
		const errorText = await res.text();
		throw new Error(`Failed to post article: ${res.status} ${res.statusText} - ${errorText}`);
	}

	const data = await res.json<Article>();
	if (!data || !data.id) {
		throw new Error('Failed to create article, no ID returned');
	}

	// add quiz to KV
	if (quiz) {
		const key = `article:quiz:${data.id}`;
		await bindings.KV.put(key, JSON.stringify(quiz), { expirationTtl: 60 * 60 * 12 * 29 }); // 14.5 days (articles are deleted after 2 weeks)
	}

	return data;
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
		console.error('AI model failed for prompt generation', { error: aiError });
		throw new Error('Failed to generate prompt using AI model', { cause: aiError });
	}

	if (!gen || !gen.output || gen.output.length === 0) {
		console.error('Failed to generate prompt: empty or invalid response', { gen });
		throw new Error('Failed to generate prompt: empty response');
	}

	const message = gen.output.find((o) => o.type === 'message');

	if (!message) {
		console.error('No valid prompt message found in response', { output: gen.output });
		throw new Error('No valid prompt message found in response');
	}

	const rawPromptText = message.content
		.find((c) => c.type === 'output_text')
		?.text?.trim()
		?.replace(/\n/g, ' ');

	const promptText = prompts.validatePromptQuestion(rawPromptText || '');

	return promptText;
}

export async function postPrompt(prompt: string, bindings: Bindings): Promise<Prompt> {
	if (!prompt || prompt.length < 10) {
		throw new Error('Prompt must be at least 10 characters long');
	}

	const url = (bindings.MANTLE_URL || 'https://api.earth-app.com') + '/v2/prompts';
	const res = await fetch(url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${bindings.ADMIN_API_KEY}`
		},
		body: JSON.stringify({ prompt, visibility: 'PUBLIC', censor: true })
	});

	if (!res.ok) {
		const errorText = await res.text();
		throw new Error(`Failed to post prompt: ${res.status} ${res.statusText} - ${errorText}`);
	}

	const data = await res.json<Prompt>();
	if (!data || !data.id) {
		throw new Error('Failed to create prompt, no ID returned');
	}

	return data;
}

// Event Endpoints

export async function retrieveActivities(bindings: Bindings): Promise<Activity[]> {
	const root = bindings.MANTLE_URL || 'https://api.earth-app.com';
	const limit = 100;
	let page = 1;
	const allActivities: Activity[] = [];

	// Fetch first page to get total count
	const firstUrl = `${root}/v2/activities?limit=${limit}&page=${page}`;
	const firstRes = await fetch(firstUrl, {
		method: 'GET',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${bindings.ADMIN_API_KEY}`
		}
	});

	if (!firstRes.ok) {
		const errorText = await firstRes.text();
		console.error(
			`Failed to retrieve activities: ${firstRes.status} ${firstRes.statusText} - ${errorText}`
		);
		return [];
	}

	const firstData = await firstRes.json<{ items: Activity[]; total: number; page: number }>();
	allActivities.push(...(firstData.items || []));
	const total = firstData.total || 0;
	const totalPages = Math.ceil(total / limit);

	// Fetch remaining pages if needed
	page++;
	while (page <= totalPages) {
		const url = `${root}/v2/activities?limit=${limit}&page=${page}`;
		const res = await fetch(url, {
			method: 'GET',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${bindings.ADMIN_API_KEY}`
			}
		});

		if (!res.ok) {
			console.error(`Failed to fetch activities page ${page}`);
			break;
		}

		const data = await res.json<{ items: Activity[] }>();
		allActivities.push(...(data.items || []));
		page++;
	}

	console.log(`Retrieved ${allActivities.length} total activities`);
	return allActivities;
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

	const ranked = await ai.run(rankerModel, {
		query: rankQuery,
		contexts: contexts.map((c) => ({ text: c.text }))
	});

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

export function retrieveEvents() {
	const allEntries = getAllEntries('/bundle/data');
	const events = getEntriesInNextWeeks(allEntries, 2);
	return events;
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
	if (entry instanceof ExactDateWithYearEntry && name.includes("'s Birthday")) {
		const yearsSince = entry.getYearsSince(date);
		if (yearsSince > 0) {
			const placeName = name.replace("'s Birthday", '');
			name = `${placeName}'s ${toOrdinal(yearsSince)} Birthday`;
		}
	}

	let descriptionResult;
	try {
		descriptionResult = await ai.run(descriptionModel, {
			messages: [
				{ role: 'system', content: prompts.eventDescriptionSystemMessage.trim() },
				{
					role: 'user',
					content: prompts.eventDescriptionPrompt(entry, date).trim()
				}
			],
			max_tokens: 450,
			temperature: 0.2 // lower temperature for factual, informative descriptions
		});
	} catch (aiError) {
		console.error('AI model failed for event description generation', {
			name: entry.name,
			error: aiError
		});
		throw new Error('Failed to generate event description using AI model');
	}

	const description = descriptionResult?.response || '';
	const validatedDescription = prompts.validateEventDescription(description, name);

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
			moho_id: id
		}
	} satisfies EventData;

	return event;
}

/**
 * Extracts the searchable location name from a full event name.
 * Only works for birthday events (names ending with "'s Birthday" or "'s [ordinal] Birthday").
 * Converts parenthetical state/country codes to comma format for better disambiguation.
 * @param eventName - Full event name (e.g., "Springfield (IL)'s Birthday", "Vallejo's 158th Birthday")
 * @returns Searchable location name (e.g., "Springfield, IL", "Vallejo") or null if not a birthday event
 */
export function extractLocationFromEventName(eventName: string): string | null {
	// Match: "Location's Birthday" or "Location's 158th Birthday"
	// Capture group 1: the location name (non-greedy)
	// Optional non-capturing group: ordinal number like "158th"
	const birthdayMatch = eventName.match(/^(.+?)'s(?:\s+\d+(?:st|nd|rd|th))?\s+Birthday$/i);
	if (!birthdayMatch || !birthdayMatch[1]) {
		return null;
	}

	const locationName = birthdayMatch[1].trim();

	// Convert parenthetical state/country codes to comma format
	// e.g., "Arlington (TX)" -> "Arlington, TX" for better place disambiguation
	// e.g., "Springfield (IL)" -> "Springfield, IL"
	return locationName.replace(/\s*\(([^)]+)\)\s*/g, ', $1').trim();
}

// returns [imageData, authorName]
export async function findPlaceThumbnail(
	name: string,
	bindings: Bindings
): Promise<[Uint8Array | null, string | null]> {
	const cleanedName = name.replace(/\s*\(([^)]+)\)\s*/g, ', $1').trim();

	const search = await fetch('https://places.googleapis.com/v1/places:searchText', {
		method: 'POST',
		body: JSON.stringify({
			textQuery: cleanedName,
			includedType: 'locality',
			maxResultCount: 1
		}),
		headers: {
			'Content-Type': 'application/json',
			'X-Goog-Api-Key': bindings.MAPS_API_KEY,
			'X-Goog-FieldMask': 'places.name'
		}
	});

	if (!search.ok) {
		console.error('Failed to search for place thumbnail', {
			name,
			cleanedName,
			status: search.status,
			statusText: search.statusText,
			body: await search.text()
		});

		throw new Error('Place search request failed');
	}

	const places = await search.json<{ places: { name: string }[] }>();

	if (!places.places || places.places.length === 0) {
		console.warn('No places found for thumbnail search', { name, cleanedName });
		return [null, null];
	}

	const placeName = places.places[0].name;

	const data = await fetch(`https://places.googleapis.com/v1/${placeName}`, {
		method: 'GET',
		headers: {
			'Content-Type': 'application/json',
			'X-Goog-Api-Key': bindings.MAPS_API_KEY,
			'X-Goog-FieldMask': 'photos'
		}
	}).then((res) =>
		res.json<{
			photos: {
				name: string;
				authorAttributions: {
					displayName: string;
				}[];
			}[];
		}>()
	);

	if (!data.photos || data.photos.length === 0) {
		console.warn('No photos found for place thumbnail', { name, placeName });
		return [null, null];
	}

	const { name: photoName, authorAttributions: author } = data.photos[0];

	const photoData = await fetch(
		`https://places.googleapis.com/v1/${photoName}/media?maxHeightPx=720&maxWidthPx=1280&key=${bindings.MAPS_API_KEY}`
	);

	if (!photoData.ok) {
		console.error('Failed to fetch place photo media', {
			name,
			placeName,
			photoName,
			status: photoData.status,
			statusText: photoData.statusText
		});
		return [null, null];
	}

	const blob = await photoData.blob();
	const arrayBuffer = await blob.arrayBuffer();
	return [new Uint8Array(arrayBuffer), author?.[0]?.displayName || null];
}

export async function uploadPlaceThumbnail(
	name: string,
	eventId: bigint,
	bindings: Bindings,
	ctx: ExecutionContext
): Promise<[Uint8Array | null, string | null]> {
	const [image0, author] = await findPlaceThumbnail(name, bindings);
	if (!image0) {
		console.warn('No thumbnail image found for event place', { name, eventId });
		return [null, null];
	}

	await uploadEventThumbnail(eventId, image0, author || 'Unknown', bindings, ctx);

	return [image0, author || 'Unknown'];
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
			.map((r) => contexts[r.id].original);

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

export async function postEvent(
	event: Awaited<ReturnType<typeof createEvent>>,
	bindings: Bindings,
	ctx: ExecutionContext
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

	const data = await res.json<any>();
	if (!data || !data.id) {
		throw new Error(`Failed to create event, no ID returned: ${JSON.stringify(data)}`);
	}

	// Only generate thumbnails for birthday events (location-based)
	// This includes countries, cities, and other places with birthdays
	// Extract location name from "Location's Birthday" or "Location's 158th Birthday" format
	const locationName = extractLocationFromEventName(event.name);
	if (locationName) {
		console.log(`Generating thumbnail for birthday event: ${locationName}`);
		await uploadPlaceThumbnail(locationName, BigInt(data.id), bindings, ctx);
	} else {
		console.log(`Skipping thumbnail generation for non-birthday event: ${event.name}`);
	}

	return data;
}
