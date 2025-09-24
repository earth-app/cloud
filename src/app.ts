import { com, kotlin } from '@earth-app/ocean';
import { Hono } from 'hono';

import {
	createActivityData,
	createArticle,
	findArticles,
	recommendArticles,
	recommendSimilarArticles
} from './boat';
import { getSynonyms } from './lang';
import * as prompts from './prompts';

import { Article, Bindings } from './types';
import { bearerAuth } from 'hono/bearer-auth';
import { toDataURL } from './util';

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
	return c.json(await createActivityData(id, activity, c.env.AI), 200);
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

app.post('/articles/recommend_similar_articles', async (c) => {
	const body = await c.req.json<{
		article: Article;
		pool: Article[];
		limit?: number;
	}>();

	if (!body.article || !body.pool) {
		return c.text('Invalid request body', 400);
	}

	if (!Array.isArray(body.pool)) {
		return c.text('Invalid request body format', 400);
	}

	if (body.pool.length === 0) {
		return c.text('No articles provided', 400);
	}

	// default limit is 5, max 10
	const limit = body.limit && body.limit > 0 && body.limit <= 10 ? body.limit : 5;

	const recommended = await recommendSimilarArticles(body.article, body.pool, limit, c.env.AI);
	return c.json(recommended, 200);
});

// Users

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

	const seen = new Set<string>();
	const recommended = com.earthapp.ocean
		.recommendActivity(all, user)
		.asJsReadonlyArrayView()
		.map((a) => JSON.parse(a.toJson()))
		.filter((a) => {
			const id = String(a.id);
			if (seen.has(id)) return false;
			seen.add(id);

			return true;
		});

	return c.json(recommended, 200);
});

app.get('/users/profile_photo/:id', async (c) => {
	const idParam = c.req.param('id');
	if (!idParam || !/^\d+$/.test(idParam)) {
		return c.text('User ID is required', 400);
	}

	const id = BigInt(idParam);
	if (id <= 0n) {
		return c.text('Invalid User ID', 400);
	}

	const photo = await prompts.getProfilePhoto(id, c.env);
	if (!photo) {
		return c.text('Profile photo not found', 404);
	}

	return c.json({ data: toDataURL(photo) });
});

app.put('/users/profile_photo/:id', async (c) => {
	const idParam = c.req.param('id');
	if (!idParam || !/^\d+$/.test(idParam)) {
		return c.text('User ID is required', 400);
	}
	const id = BigInt(idParam);

	if (id <= 0n) {
		return c.text('Invalid User ID', 400);
	}

	if (id === 1n) {
		return c.text('Cannot replace admin profile photo', 400);
	}

	const body = await c.req.json<prompts.UserProfilePromptData>();
	if (!body) {
		return c.text('Invalid request body', 400);
	}

	const photo = await prompts.newProfilePhoto(body, id, c.env);
	if (!photo) {
		return c.text('Failed to update profile photo', 500);
	}

	return c.json({ data: toDataURL(photo) });
});

app.post('/users/recommend_articles', async (c) => {
	const body = await c.req.json<{
		pool: Article[];
		activities: string[];
		limit?: number;
	}>();

	if (!body.pool || !body.activities) {
		return c.text('Invalid request body', 400);
	}

	if (!Array.isArray(body.pool) || !Array.isArray(body.activities)) {
		return c.text('Invalid request body format', 400);
	}

	if (body.pool.length === 0 || body.activities.length === 0) {
		return c.text('No articles or activities provided', 400);
	}

	// default limit is 10, max 25
	const limit = body.limit && body.limit > 0 && body.limit <= 25 ? body.limit : 10;

	const recommended = await recommendArticles(body.pool, body.activities, limit, c.env.AI);
	return c.json(recommended, 200);
});

export default app;
