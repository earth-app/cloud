import * as ocean from '@earth-app/ocean';
import { Hono } from 'hono';

import { findArticles } from './boat';
import { getSynonyms, isValidWord } from './lang';
import * as prompts from './prompts';

import { Activity as Activity, Bindings } from './types';
import { bearerAuth } from 'hono/bearer-auth';

const textModel = '@hf/mistral/mistral-7b-instruct-v0.2';
const app = new Hono<{ Bindings: Bindings }>();

app.use('*', async (c, next) => {
	const token = c.env.ADMIN_API_TOKEN;
	return bearerAuth({ token })(c, next);
});

// Implementation
app.get('/synonyms', async (c) => {
	const word = c.req.query('word')?.trim();
	if (!word || word.length < 3) {
		return c.text('Word must be at least 3 characters long', 400);
	}

	const synonyms = await getSynonyms(word);
	if (!synonyms || synonyms.length === 0) {
		return c.json([], 200);
	}

	return c.json(synonyms, 200);
});

app.get('/activity/:id', async (c) => {
	const id = c.req.param('id')?.toLowerCase();
	if (!id) {
		return c.text('Activity ID is required', 400);
	}

	if (id.length < 3 || id.length > 20) {
		return c.text('Activity ID must be between 3 and 20 characters', 400);
	}

	const activity = id.replace(/_/g, ' ');

	// Generate description
	const description = await c.env.AI.run(textModel, {
		messages: [
			{ role: 'system', content: prompts.activityDescriptionSystemMessage.trim() },
			{ role: 'user', content: prompts.activityDescriptionPrompt(activity).trim() }
		],
		max_tokens: 160
	});
	const descRaw = description?.response?.trim() || `No description available for ${id}.`;

	// Generate tags
	const tagsResult = await c.env.AI.run(textModel, {
		messages: [
			{ role: 'system', content: prompts.activityTagsSystemMessage.trim() },
			{ role: 'user', content: activity }
		],
		max_tokens: 45
	});

	const validTags = ocean.com.earthapp.activity.ActivityType.values().map((t) =>
		t.name.trim().toUpperCase()
	);
	const tags = tagsResult?.response
		?.trim()
		.split(',')
		.map((tag) =>
			tag
				.trim()
				.toUpperCase()
				.replace(/[^A-Z0-9_]/g, '')
		)
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
