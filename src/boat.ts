import { com } from '@earth-app/ocean';
import { Context } from 'hono';

import { Activity, Article, Bindings, OceanArticle, Prompt } from './types';
import { getSynonyms } from './lang';
import * as prompts from './prompts';
import { Ai } from '@cloudflare/workers-types';

const newActivityModel = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const activityModel = '@cf/google/gemma-3-12b-it';
const tagsModel = '@cf/meta/llama-3.1-8b-instruct-fp8';
const articleModel = '@cf/mistralai/mistral-small-3.1-24b-instruct';
const promptModel = '@cf/meta/llama-4-scout-17b-16e-instruct';

export async function createNewActivity(bindings: Bindings): Promise<string | undefined> {
	const listEndpoint = `${bindings.MANTLE_URL || 'https://api.earth-app.com'}/v2/activities/list?limit=1000`;
	const first = await fetch(listEndpoint).then((res) =>
		res.json<{ total: number; items: string[] }>()
	);

	let total = first.total;
	let retrieved = 1000;
	let activityChunks = [];
	activityChunks.push(first.items); // add first chunk

	let i = 1;
	while (retrieved < total) {
		const paginatedEndpoint = `${listEndpoint}&page=${i + 1}`;
		const chunk = await fetch(paginatedEndpoint).then((res) => res.json<{ items: string[] }>());
		activityChunks.push(chunk.items);

		i++;
		retrieved += 1000;
	}

	// Prompt with messages as list of chunks
	const res = (await bindings.AI.run(newActivityModel, {
		messages: [
			{ role: 'system', content: prompts.activityGenerationSystemMessage.trim() },
			...activityChunks.map((chunk) => {
				return { role: 'user', content: chunk.join(',') };
			})
		],
		max_tokens: 25
	})) as { response: string | null | undefined };

	const activity = res?.response?.trim();

	// check excess thinking
	if (activity?.includes('is already in the list, a new activity is:')) {
		return activity
			.split('is already in the list, a new activity is:')[1]
			.trim()
			.toLowerCase()
			.replace(/\s+/g, '_');
	}

	return activity;
}

export async function createActivityData(id: string, activity: string, ai: Ai) {
	try {
		// Generate description
		const description = await ai.run(activityModel, {
			messages: [
				{ role: 'system', content: prompts.activityDescriptionSystemMessage.trim() },
				{ role: 'user', content: prompts.activityDescriptionPrompt(activity).trim() }
			]
		});
		const desc = (description?.response?.trim() || `No description available for ${id}.`)
			.replace(/\n/g, ' ')
			.replace(/“/g, '"')
			.replace(/—/g, ', '); // em dash to comma

		// Generate tags
		const tagsResult = await ai.run(tagsModel, {
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
	const gen = await ai.run(promptModel, {
		messages: [
			{ role: 'system', content: prompts.promptsSystemMessage.trim() },
			{ role: 'user', content: prompts.promptsQuestionPrompt.trim() }
		],
		max_tokens: 40
	});

	const response = gen?.response?.trim();
	if (!response || response.length < 10) {
		throw new Error('Failed to generate prompt, response too short');
	}

	return response;
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
