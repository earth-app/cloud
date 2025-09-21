import { com } from '@earth-app/ocean';

import { Activity, Article, Bindings, OceanArticle, Prompt } from './types';
import { getSynonyms } from './lang';
import * as prompts from './prompts';
import { Ai } from '@cloudflare/workers-types';
import { chunkArray } from './util';

const activityModel = '@cf/meta/llama-3.2-11b-vision-instruct';
const tagsModel = '@cf/meta/llama-3.1-8b-instruct-fp8';
const articleTopicModel = '@cf/meta/llama-3.2-3b-instruct';
const articleRankerModel = '@cf/baai/bge-reranker-base';
const articleModel = '@cf/mistralai/mistral-small-3.1-24b-instruct';
const promptModel = '@cf/openai/gpt-oss-120b';

export async function createActivityData(id: string, activity: string, ai: Ai) {
	try {
		// Generate description with timeout and retry logic
		let description;
		try {
			description = await ai.run(activityModel, {
				messages: [
					{ role: 'system', content: prompts.activityDescriptionSystemMessage.trim() },
					{ role: 'user', content: prompts.activityDescriptionPrompt(activity).trim() }
				],
				max_tokens: 350
			});
		} catch (aiError) {
			console.error('AI model failed for activity description', { activity, error: aiError });
			throw new Error(`AI model failed to generate description for activity: ${activity}`);
		}

		const rawDesc = description?.response || '';
		const desc = prompts.validateActivityDescription(rawDesc, activity);
		// Note: sanitization now handled within validateActivityDescription

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
			'heroicons'
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
			max_tokens: 16
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
	// Chunk by 125 articles to reduce latency and neuron load
	const batches = chunkArray(searchResults, 125);

	const allArticles: { text: string; ocean: OceanArticle }[] = [];
	const rankQuery = prompts.articleClassificationQuery(topic, tags);
	const allRanked: { id: number; score: number }[] = [];

	for (const batch of batches) {
		const contexts = batch
			.filter((article) => article.abstract || article.content) // must have abstract or content
			.filter((article) => article.title.match(/[^\x00-\x7F]+/gim)?.length || 0 === 0) // title must be only ascii
			.map((article) => ({
				text:
					(article.title || '') +
					' by ' +
					(article.author || 'Unknown') +
					' | Tags: ' +
					(article.keywords || []).join(', ') +
					'\n' +
					(article.abstract || '').substring(0, 200),
				ocean: article // store original for later retrieval
			}));
		allArticles.push(...contexts);

		// Rank this batch
		const ranked = await ai.run(articleRankerModel, {
			query: rankQuery,
			contexts: contexts.map((c) => ({ text: c.text })) // remove 'ocean' field for ranking
		});

		if (!ranked || !ranked.response) {
			throw new Error('Failed to rank articles: ' + JSON.stringify(ranked));
		}

		allRanked.push(
			...ranked.response
				.filter((r) => r.id !== undefined)
				.map((r) => ({ id: r.id!, score: r.score || 0 }))
		);
	}

	// Find highest-ranked article
	const best = allRanked.sort((a, b) => b.score - a.score)[0];
	if (!best) {
		throw new Error('No best article found after ranking: length ' + allRanked.length);
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

	return await Promise.all(results);
}

export async function createArticle(
	ocean: OceanArticle,
	ai: Ai,
	tags: string[]
): Promise<Partial<Article>> {
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
				max_tokens: 24
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
				max_tokens: 1000 // Add max_tokens limit for summary
			});
		} catch (aiError) {
			console.error('AI model failed for article summary generation', {
				title: ocean.title,
				error: aiError
			});
			throw new Error('Failed to generate article summary using AI model');
		}

		const summary = prompts.validateArticleSummary(summaryResult?.response || '', ocean.title);

		return {
			ocean,
			tags,
			title: title,
			description: summary.substring(0, 256) + '...',
			color: ocean.theme_color || '#ffffff',
			content: summary
		};
	} catch (error) {
		console.error('Error creating article:', error);
		throw new Error(
			`Article creation failed: ${error instanceof Error ? error.message : 'Unknown error'}`
		);
	}
}

export async function postArticle(article: Partial<Article>, bindings: Bindings): Promise<Article> {
	if (!article.title || !article.description || !article.content) {
		throw new Error('Article must have title, description and content');
	}

	const url = (bindings.MANTLE_URL || 'https://api.earth-app.com') + '/v2/articles';
	const res = await fetch(url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${bindings.ADMIN_API_KEY}`
		},
		body: JSON.stringify(article)
	});

	if (!res.ok) {
		const errorText = await res.text();
		throw new Error(`Failed to post article: ${res.status} ${res.statusText} - ${errorText}`);
	}

	const data = await res.json<Article>();
	if (!data || !data.id) {
		throw new Error('Failed to create article, no ID returned');
	}

	return data;
}

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
		body: JSON.stringify({ prompt, visibility: 'PUBLIC' })
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
