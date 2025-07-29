import { com } from '@earth-app/ocean';
import { Context } from 'hono';

import { Activity, Article, Bindings, OceanArticle } from './types';
import { getSynonyms } from './lang';
import * as prompts from './prompts';
import { Ai } from '@cloudflare/workers-types';

const activityModel = '@hf/google/gemma-7b-it';
const articleModel = '@cf/mistralai/mistral-small-3.1-24b-instruct';

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

export async function findArticles(
	query: string,
	c: Context<{ Bindings: Bindings }>,
	limit: number = 1
) {
	if (!HAS_PUBMED_API_KEY && c.env.NCBI_API_KEY) {
		com.earthapp.ocean.boat.Scraper.setApiKey('PubMed', c.env.NCBI_API_KEY);
		HAS_PUBMED_API_KEY = true;
	}

	const res = await com.earthapp.ocean.boat.searchAllAsPromise(
		com.earthapp.ocean.boat.Scraper.Companion,
		query,
		limit
	);
	const results = res
		.asJsReadonlyArrayView()
		.map(async (item) => JSON.parse(item.toJson()) satisfies OceanArticle);

	return await Promise.all(results);
}

export async function createArticle(ocean: OceanArticle, ai: Ai): Promise<Article> {
	const id = `cloud:article:${ocean.url}`;

	const tagCount = Math.random() * 3 + 2; // Randomly select 2 to 5 tags
	const tags = com.earthapp.activity.ActivityType.values()
		.sort(() => Math.random() - 0.5)
		.slice(0, tagCount)
		.map((t) => t.name.trim().toUpperCase());

	const articleContent = ocean.content.trim().substring(0, 256000); // Limit to 256k characters

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
		]
	});

	if (!summary || !summary.response) {
		throw new Error('Failed to generate article summary');
	}

	return {
		id,
		ocean,
		tags,
		title: title.response.trim(),
		summary: summary.response.trim(),
		created_at: new Date().toISOString()
	};
}
