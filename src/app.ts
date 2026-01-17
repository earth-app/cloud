import { com, kotlin } from '@earth-app/ocean';
import { Hono } from 'hono';

import {
	createActivityData,
	findArticles,
	recommendArticles,
	recommendSimilarArticles
} from './boat';
import { getSynonyms } from './lang';
import * as prompts from './prompts';

import { Article, Bindings } from './types';
import { bearerAuth } from 'hono/bearer-auth';
import {
	toDataURL,
	getProfilePhoto,
	newProfilePhoto,
	getProfileVariation,
	ImageSizes,
	validSizes,
	getEventThumbnail,
	uploadEventThumbnail
} from './util';
import { tryCache } from './cache';
import {
	addActivityToJourney,
	getActivityJourney,
	getJourney,
	incrementJourney,
	resetJourney
} from './journies';

const app = new Hono<{ Bindings: Bindings }>();

// app.use('*', async (c, next) => {
// 	const token = c.env.ADMIN_API_KEY;
// 	return bearerAuth({ token, invalidAuthenticationHeaderMessage: 'Invalid Administrator API Key' })(
// 		c,
// 		next
// 	);
// });

// Implementation

// Activities
app.get('/synonyms', async (c) => {
	const word = c.req.query('word')?.trim();
	if (!word || word.length < 3) {
		return c.text('Word must be at least 3 characters long', 400);
	}

	const cacheKey = `cache:synonyms:${word.toLowerCase()}`;
	const synonyms = await tryCache(cacheKey, c.env.CACHE, async () => {
		return getSynonyms(word);
	});

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
	const cacheKey = `cache:activity_data:${id}`;

	return c.json(
		await tryCache(cacheKey, c.env.CACHE, async () => {
			return createActivityData(id, activity, c.env.AI);
		}),
		200
	);
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

	if (body.pool.length > 20) {
		return c.text('Article pool cannot exceed 20 articles', 400);
	}

	// default limit is 5, max 10
	const limit = body.limit && body.limit > 0 && body.limit <= 10 ? body.limit : 5;

	// Fast hash to keep cache key under 512 bytes
	const poolIds = body.pool
		.map((a) => a.id)
		.sort()
		.join(',');
	let poolHash = 0;
	for (let i = 0; i < poolIds.length; i++) {
		poolHash = ((poolHash << 5) - poolHash + poolIds.charCodeAt(i)) & 0xffffffff;
	}
	const cacheKey = `cache:similar_articles:${body.article.id}:${Math.abs(poolHash).toString(36)}:${limit}`;

	return c.json(
		await tryCache(cacheKey, c.env.CACHE, async () => {
			return recommendSimilarArticles(body.article, body.pool, limit, c.env.AI);
		}),
		200
	);
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

	const sizeParam = c.req.query('size') || '128';
	const size = sizeParam ? (parseInt(sizeParam, 10) as ImageSizes) : undefined;
	if (!size || size <= 0 || size > 1024 || isNaN(size)) {
		return c.text('Invalid size parameter', 400);
	}

	const photo = await getProfileVariation(id, size, c.env, c.executionCtx);
	if (!photo) {
		return c.text('Profile photo not found', 404);
	}

	let size0 = size;
	if (validSizes.indexOf(size) === -1) {
		size0 = 1024;
	}

	const cacheKey = `user:profile_photo:${id}:${size0}`;
	return c.json(
		await tryCache(cacheKey, c.env.CACHE, async () => ({ data: toDataURL(photo) })),
		200
	);
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

	const photo = await newProfilePhoto(body, id, c.env, c.executionCtx);
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

	if (body.pool.length > 20) {
		return c.text('Article pool cannot exceed 20 articles', 400);
	}

	if (body.activities.length > 10) {
		return c.text('Activities cannot exceed 10 items', 400);
	}

	// default limit is 10, max 25
	const limit = body.limit && body.limit > 0 && body.limit <= 25 ? body.limit : 10;

	// Fast hashing to keep cache key under 512 bytes
	const activities = body.activities
		.map((a) => a.toLowerCase().trim())
		.sort()
		.join(',');
	let activitiesHash = 0;
	for (let i = 0; i < activities.length; i++) {
		activitiesHash =
			((activitiesHash << 5) - activitiesHash + activities.charCodeAt(i)) & 0xffffffff;
	}

	const poolIds = body.pool
		.map((a) => a.id)
		.sort()
		.join(',');
	let poolHash = 0;
	for (let i = 0; i < poolIds.length; i++) {
		poolHash = ((poolHash << 5) - poolHash + poolIds.charCodeAt(i)) & 0xffffffff;
	}

	const cacheKey = `cache:recommended_articles:${Math.abs(activitiesHash).toString(36)}:${Math.abs(poolHash).toString(36)}:${limit}`;

	return c.json(
		await tryCache(cacheKey, c.env.CACHE, async () => {
			return recommendArticles(body.pool, body.activities, limit, c.env.AI);
		}),
		200
	);
});

/// User Journeys

app.get('/users/journey/activity/:id/count', async (c) => {
	const id = c.req.param('id')?.toLowerCase();
	if (!id) {
		return c.text('Journey ID is required', 400);
	}

	if (id.length < 3 || id.length > 50) {
		return c.text('Journey ID must be between 3 and 50 characters', 400);
	}

	try {
		const activities = await getActivityJourney(id, c.env.KV);
		return c.json({ count: activities.length }, 200);
	} catch (err) {
		console.error(`Error getting activity journey for ID '${id}':`, err);
		return c.text('Failed to get activity journey', 500);
	}
});

app.get('/users/journey/:type/:id', async (c) => {
	const id = c.req.param('id')?.toLowerCase();
	const type = c.req.param('type')?.toLowerCase();
	if (!id || !type) {
		return c.text('Journey ID and type are required', 400);
	}

	if (id.length < 3 || id.length > 50) {
		return c.text('Journey ID must be between 3 and 50 characters', 400);
	}

	try {
		const [count, lastWrite] = await getJourney(id, type, c.env.KV);
		return c.json({ count, lastWrite }, 200);
	} catch (err) {
		console.error(`Error getting journey '${type}' for ID '${id}':`, err);
		return c.text('Failed to get journey', 500);
	}
});

app.post('/users/journey/activity/:id', async (c) => {
	const id = c.req.param('id')?.toLowerCase();
	const activity = c.req.query('activity')?.toLowerCase();
	if (!id || !activity) {
		return c.text('Journey ID and activity are required', 400);
	}

	if (id.length < 3 || id.length > 50) {
		return c.text('Journey ID must be between 3 and 50 characters', 400);
	}

	try {
		const current = await getActivityJourney(id, c.env.KV);
		if (current.includes(activity)) {
			return c.json({ count: current.length }, 200);
		}

		// Calculate new count for response, run addition in background
		const count = current.length + 1;
		c.executionCtx.waitUntil(addActivityToJourney(id, activity, c.env.KV));

		return c.json({ count }, 201);
	} catch (err) {
		console.error(`Error adding activity '${activity}' to journey for ID '${id}':`, err);
		return c.text('Failed to add activity to journey', 500);
	}
});

app.post('/users/journey/:type/:id/increment', async (c) => {
	const id = c.req.param('id')?.toLowerCase();
	const type = c.req.param('type')?.toLowerCase();
	if (!id || !type) {
		return c.text('Journey ID and type are required', 400);
	}

	if (id.length < 3 || id.length > 50) {
		return c.text('Journey ID must be between 3 and 50 characters', 400);
	}

	const [value, lastWrite] = await getJourney(id, type, c.env.KV);
	if (Date.now() - lastWrite < 60 * 60 * 24 * 1000) {
		// Bump expirationTtl
		const key = `journey:${type}:${id}`;
		c.executionCtx.waitUntil(
			c.env.KV.put(key, value.toString(), {
				expirationTtl: 60 * 60 * 24 * 2,
				metadata: { lastWrite: Date.now() }
			})
		);

		return c.json({ count: value }, 200);
	}

	try {
		const newCount = await incrementJourney(id, type, c.env.KV);
		return c.json({ count: newCount }, 201);
	} catch (err) {
		console.error(`Error incrementing journey '${type}' for ID '${id}':`, err);
		return c.text('Failed to increment journey', 500);
	}
});

app.delete('/users/journey/:type/:id/delete', async (c) => {
	const id = c.req.param('id')?.toLowerCase();
	const type = c.req.param('type')?.toLowerCase();
	if (!id || !type) {
		return c.text('Journey ID and type are required', 400);
	}

	if (id.length < 3 || id.length > 50) {
		return c.text('Journey ID must be between 3 and 50 characters', 400);
	}

	try {
		await resetJourney(id, type, c.env.KV);
		return c.body(null, 204);
	} catch (err) {
		console.error(`Error resetting journey '${type}' for ID '${id}':`, err);
		return c.text('Failed to reset journey', 500);
	}
});

// Events

app.get('/events/thumbnail/:id', async (c) => {
	const idParam = c.req.param('id');
	if (!idParam || !/^\d+$/.test(idParam)) {
		return c.text('Event ID is required', 400);
	}
	const id = BigInt(idParam);

	if (id <= 0n) {
		return c.text('Invalid Event ID', 400);
	}

	const image = await getEventThumbnail(id, c.env);
	if (!image) {
		return c.text('Event thumbnail not found', 404);
	}

	return c.body(new Uint8Array(image), 200, {
		'Content-Type': 'image/webp',
		'Content-Length': image.length.toString(),
		'Content-Disposition': `inline; filename="event_${id}_thumbnail.webp"`,
		'Cache-Control': 'public, max-age=31536000, immutable'
	});
});

app.post('/events/thumbnail/:id', async (c) => {
	const idParam = c.req.param('id');
	if (!idParam || !/^\d+$/.test(idParam)) {
		return c.text('Event ID is required', 400);
	}
	const id = BigInt(idParam);

	if (id <= 0n) {
		return c.text('Invalid Event ID', 400);
	}

	const contentType = c.req.header('Content-Type') || '';

	// content will be converted to webp, but must be an image type
	if (!contentType.startsWith('image/')) {
		return c.text('Content-Type must be an image type', 400);
	}

	const body = await c.req.arrayBuffer();

	const imageData = new Uint8Array(body);
	if (imageData.length === 0) {
		return c.text('Image data is required', 400);
	}

	await uploadEventThumbnail(id, imageData, c.env, c.executionCtx);
	return c.body(null, 204);
});

export default app;
