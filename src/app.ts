import * as ocean from '@earth-app/ocean';
import { Hono } from 'hono';

import { findArticles } from './boat';
import { getActivity, setActivity } from './db';
import { getSynonyms, isValidWord } from './lang';
import * as prompts from './prompts';

import { ActivityData, Bindings } from './types';

const textModel = '@cf/meta/llama-3.2-1b-instruct';
const app = new Hono<{ Bindings: Bindings }>();

// app.use('*', async (c, next) => {
//     const token = c.env.CLOUD_API_TOKEN
//     return bearerAuth({ token })(c, next)
// })

// Implementation
app.get('/activity/:id', async (c) => {
	const id = c.req.param('id')?.toLowerCase();
	if (!id) {
		return c.text('Activity ID is required', 400);
	}

	if (id.length < 3 || id.length > 20) {
		return c.text('Activity ID must be between 3 and 20 characters', 400);
	}

	// Try to fetch existing
	const existing = await getActivity(c.env.DB, id);
	if (existing) return c.json(existing, 200);

	const activity = id.replace(/_/g, ' ');
	if (!(await isValidWord(activity))) {
		return c.text(`Activity '${id}' is not a valid word`, 400);
	}

	// Generate description
	const description = await c.env.AI.run(textModel, {
		messages: [
			{ role: 'system', content: prompts.activityDescriptionSystemMessage.trim() },
			{ role: 'user', content: prompts.activityDescriptionPrompt(activity).trim() }
		]
	});
	const descRaw = description?.response?.trim() || `No description available for ${id}.`;

	// Generate tags
	const tagsResult = await c.env.AI.run(textModel, {
		messages: [
			{ role: 'system', content: prompts.activityTagsSystemMessage.trim() },
			{ role: 'user', content: `'${activity}'` }
		]
	});
	const validTags = ocean.com.earthapp.activity.ActivityType.values().map((t) =>
		t.name.trim().toUpperCase()
	);
	const tags = tagsResult?.response
		?.trim()
		.split(',')
		.map((tag) => tag.trim().toUpperCase())
		.filter((tag) => tag.length > 0)
		.filter((tag) => validTags.includes(tag)) || ['OTHER'];

	const now = new Date().toISOString();

	let aliases: string | null = null;
	const synonyms = await getSynonyms(activity);
	if (synonyms && synonyms.length > 0) {
		aliases = synonyms
			.map((syn) => syn.trim().toLowerCase())
			.filter((syn) => syn.length > 0 && syn !== activity)
			.join(',');
	}

	const activityData = {
		id: 0, // Will be set by DB auto-increment
		name: id,
		human_name: id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
		types: tags.join(','),
		description: descRaw,
		aliases: aliases,
		created_at: now,
		updated_at: now
	} as ActivityData;

	try {
		await setActivity(c.env.DB, activityData);
	} catch (err) {
		console.error(`Failed to save activity '${id}':`, err);
		return c.text(`Failed to save activity`, 500);
	}

	return c.json(activityData, 201);
});

app.get('/article_search', async (c) => {
	const query = c.req.query('q')?.trim();
	if (!query || query.length < 3) {
		return c.text('Query must be at least 3 characters long', 400);
	}

	try {
		const articles = await findArticles(query, c);
		if (articles.length === 0) {
			return c.text('No articles found', 404);
		}

		return c.json(articles, 200);
	} catch (err) {
		console.error(`Error searching articles for query '${query}':`, err);
		return c.text('Failed to search articles', 500);
	}
});

export default app;
