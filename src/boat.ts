import { com } from '@earth-app/ocean';
import { Context } from 'hono';

import { Activity, Article, Bindings, OceanArticle, Prompt } from './types';
import { getSynonyms } from './lang';
import * as prompts from './prompts';
import { Ai } from '@cloudflare/workers-types';
import { validateCandidate } from './util';

const activityModel = '@hf/google/gemma-7b-it';
const articleModel = '@cf/mistralai/mistral-small-3.1-24b-instruct';
const promptModel = '@cf/qwen/qwen1.5-14b-chat-awq';

export async function createActivityData(id: string, activity: string, ai: Ai) {
	// Generate description
	const description = await ai.run(activityModel, {
		messages: [
			{ role: 'system', content: prompts.activityDescriptionSystemMessage.trim() },
			{ role: 'user', content: prompts.activityDescriptionPrompt(activity).trim() }
		]
	});
	const descRaw = description?.response?.trim() || `No description available for ${id}.`;

	// Generate tags
	const tagsResult = await ai.run(activityModel, {
		messages: [
			{ role: 'system', content: prompts.activityTagsSystemMessage.trim() },
			{ role: 'user', content: `'${activity}'` }
		]
	});
	const validTags = com.earthapp.activity.ActivityType.values().map((t) =>
		t.name.trim().toUpperCase()
	);
	const tags = tagsResult?.response
		?.trim()
		.split(',')
		.map((tag) => tag.trim().toUpperCase())
		.filter((tag) => tag.length > 0)
		.filter((tag) => validTags.includes(tag)) || ['OTHER'];

	let aliases: string[] = [];
	const synonyms = await getSynonyms(activity);
	if (synonyms && synonyms.length > 0) {
		aliases.push(
			...synonyms
				.map((syn) => syn.trim().toLowerCase())
				.filter((syn) => syn.length > 0 && syn !== activity)
		);
	}

	const activityData = {
		id: id,
		name: id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
		types: tags,
		description: descRaw,
		aliases: aliases
	} satisfies Activity;

	return activityData;
}

let HAS_PUBMED_API_KEY = false;
export async function findArticles(query: string, bindings: Bindings, pageLimit: number = 1) {
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

export async function createArticle(ocean: OceanArticle, ai: Ai): Promise<Partial<Article>> {
	const tagCount = Math.floor(Math.random() * 3) + 3; // Randomly select 3 to 5 tags (fixed Math.random calculation)
	const tags = com.earthapp.activity.ActivityType.values()
		.sort(() => Math.random() - 0.5)
		.slice(0, tagCount)
		.map((t) => t.name.trim().toUpperCase());

	const maxContentLength = 100000;
	const articleContent =
		ocean.content?.trim()?.substring(0, maxContentLength) || ocean.abstract?.trim() || '';

	if (!articleContent) {
		throw new Error('No content available for article generation');
	}

	try {
		const title = await ai.run(articleModel, {
			messages: [
				{ role: 'system', content: prompts.articleTitlePrompt(ocean, tags).trim() },
				{ role: 'user', content: ocean.title.trim() }
			],
			max_tokens: 24
		});
		if (!title || !title.response) {
			throw new Error('Failed to generate article title');
		}

		const summary = await ai.run(articleModel, {
			messages: [
				{ role: 'system', content: prompts.articleSystemMessage.trim() },
				{ role: 'user', content: articleContent },
				{ role: 'user', content: prompts.articleSummaryPrompt(ocean, tags).trim() }
			],
			max_tokens: 1000 // Add max_tokens limit for summary
		});

		if (!summary || !summary.response) {
			throw new Error('Failed to generate article summary');
		}

		return {
			ocean,
			tags,
			title: title.response.trim(),
			description: summary.response.substring(0, 25) + '...',
			author: ocean.author || 'Cloud',
			author_id: 'cloud',
			color: ocean.theme_color || '#ffffff',
			content: summary.response.trim(),
			created_at: new Date().toISOString()
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

	const url = (bindings.MANTLE_URL || 'https://api.earth-app.com') + '/v1/articles/create';
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
	for (let attempt = 0; attempt < 6; attempt++) {
		const gen = await ai.run(promptModel, {
			messages: [
				{ role: 'system', content: prompts.promptsSystemMessage.trim() },
				{ role: 'user', content: prompts.promptsQuestionPrompt.trim() }
			],
			temperature: 0.62,
			max_tokens: 40
		});

		const raw = gen?.response?.trim();
		if (!raw) continue;

		const candidate = raw.split('\n')[0].trim();
		if (validateCandidate(candidate, 80, 15)) return candidate;

		const polishInstruction = `
            You must rewrite this single question to obey these exact rules:
            - Output exactly one sentence (one line), end with a question mark.
            - Use ASCII characters only; do not output any non-ASCII script.
            - Keep meaning and tone, shorten if needed to meet length limits.
            - Under 80 characters, under 15 words, at most one comma.
            - Do not add or remove the core idea; only make it concise and ASCII-only.
            Output only the rewritten question line.
            Original: ${candidate}`.trim();

		const polished = await ai.run(promptModel, {
			messages: [
				{
					role: 'system',
					content: 'You are a precise copyeditor. Output only the single rewritten question.'
				},
				{ role: 'user', content: polishInstruction }
			],
			temperature: 0.2,
			max_tokens: 40
		});

		const polishedText = polished?.response?.trim()?.split('\n')[0]?.trim();
		if (validateCandidate(polishedText || '', 80, 15)) return polishedText!;
	}

	throw new Error('Failed to generate a valid ASCII question after attempts');
}

export async function postPrompt(prompt: string, bindings: Bindings): Promise<Prompt> {
	if (!prompt || prompt.length < 10) {
		throw new Error('Prompt must be at least 10 characters long');
	}

	const url = (bindings.MANTLE_URL || 'https://api.earth-app.com') + '/v1/prompts/create';
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
