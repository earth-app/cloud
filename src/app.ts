import { com, kotlin } from '@earth-app/ocean';
import { Hono } from 'hono';

import { createArticle, findArticles } from './boat';
import { getSynonyms } from './lang';
import * as prompts from './prompts';

import { Activity as Activity, Bindings } from './types';
import { bearerAuth } from 'hono/bearer-auth';

const textModel = '@cf/qwen/qwen1.5-14b-chat-awq';
const app = new Hono<{ Bindings: Bindings }>();

app.use('*', async (c, next) => {
	const token = c.env.ADMIN_API_KEY;
	return bearerAuth({ token, invalidAuthenticationHeaderMessage: 'Invalid Administrator API Key' })(
		c,
		next
	);
});

// Implementation

// Activities
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

	if (id.length < 3 || id.length > 50) {
		return c.text('Activity ID must be between 3 and 50 characters', 400);
	}

	const activity = id.replace(/_/g, ' ');

	// Generate description
	const description = await c.env.AI.run(textModel, {
		messages: [
			{ role: 'system', content: prompts.activityDescriptionSystemMessage.trim() },
			{ role: 'user', content: prompts.activityDescriptionPrompt(activity).trim() }
		],
		max_tokens: 350
	});
	const descRaw =
		description?.response?.replace(/[\"\n]/g, '').trim() || `No description available for ${id}.`;

	// Generate tags
	const tagsResult = await c.env.AI.run(textModel, {
		messages: [
			{ role: 'system', content: prompts.activityTagsSystemMessage.trim() },
			{ role: 'user', content: activity }
		],
		max_tokens: 60
	});
	const validTags = com.earthapp.activity.ActivityType.values().map((t) =>
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

// Articles
app.get('/articles/search', async (c) => {
	const query = c.req.query('q')?.trim();
	if (!query || query.length < 3) {
		return c.text('Query must be at least 3 characters long', 400);
	}

	try {
		const articles = await findArticles(query, c.env);
		if (articles.length === 0) {
			return c.text('No articles found', 404);
		}

		return c.json(articles, 200);
	} catch (err) {
		console.error(`Error searching articles for query '${query}':`, err);
		return c.text('Failed to search articles', 500);
	}
});

// User Recommendation
app.post('/users/recommend_activities', async (c) => {
	const body = await c.req.json<{
		all: {
			type: 'com.earthapp.activity.Activity';
			id: string;
			name: string;
			description: string;
			aliases: string[];
			activity_types: (typeof com.earthapp.activity.ActivityType.prototype.name)[];
		}[];
		user: {
			type: 'com.earthapp.activity.Activity';
			id: string;
			name: string;
			description: string;
			aliases: string[];
			activity_types: (typeof com.earthapp.activity.ActivityType.prototype.name)[];
		}[];
	}>();

	if (!body.all || !body.user) {
		return c.text('Invalid request body', 400);
	}

	if (!Array.isArray(body.all) || !Array.isArray(body.user)) {
		return c.text('Invalid request body format', 400);
	}

	if (body.all.length === 0 || body.user.length === 0) {
		return c.text('No activities or user data provided', 400);
	}

	const all = kotlin.collections.KtList.fromJsArray(
		body.all.map(
			(a) =>
				com.earthapp.Exportable.Companion.fromJson(
					JSON.stringify(a)
				) as com.earthapp.activity.Activity
		)
	);
	const user = kotlin.collections.KtList.fromJsArray(
		body.user.map(
			(u) =>
				com.earthapp.Exportable.Companion.fromJson(
					JSON.stringify(u)
				) as com.earthapp.activity.Activity
		)
	);

	const recommended = com.earthapp.ocean.recommendActivity(all, user);
	return c.json(recommended, 200);
});

export default app;
