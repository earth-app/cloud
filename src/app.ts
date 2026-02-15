import { com, kotlin } from '@earth-app/ocean';
import { Context, Hono } from 'hono';

import {
	ArticleQuizQuestion,
	createActivityData,
	createArticleQuiz,
	extractLocationFromEventName,
	findArticles,
	recommendArticles,
	recommendEvents,
	recommendSimilarArticles,
	recommendSimilarEvents,
	uploadPlaceThumbnail
} from './content/boat';
import { getSynonyms } from './util/dictionary';
import * as prompts from './util/ai';

import { Article, Bindings, Event, EventImage, EventImageSubmission } from './util/types';
import { bearerAuth } from 'hono/bearer-auth';
import {
	toDataURL,
	newProfilePhoto,
	getProfileVariation,
	ImageSizes,
	getEventThumbnail,
	uploadEventThumbnail,
	deleteEventThumbnail,
	submitEventImage,
	normalizeId,
	migrateAllLegacyKeys,
	batchProcess,
	deleteEventImageSubmission,
	getEventImage,
	getEventImageSubmissionsWithData
} from './util/util';
import { tryCache } from './util/cache';
import {
	addActivityToJourney,
	getActivityJourney,
	getJourney,
	incrementJourney,
	resetJourney,
	retrieveLeaderboard,
	retrieveLeaderboardRank,
	TOP_LEADERBOARD_COUNT
} from './user/journies';
import {
	badges,
	getBadgeProgress,
	addBadgeProgress,
	grantBadge,
	isBadgeGranted,
	getBadgeMetadata,
	getGrantedBadges,
	revokeBadge,
	resetBadgeProgress,
	checkAndGrantBadges
} from './user/badges';
import {
	getImpactPoints,
	addImpactPoints,
	removeImpactPoints,
	setImpactPoints
} from './user/points';
import { scoreImage, ScoreResult, scoreText } from './content/ferry';
import { sendUserNotification } from './user/notifications';

const app = new Hono<{ Bindings: Bindings }>();

app.use('*', async (c, next) => {
	const token = c.env.ADMIN_API_KEY;
	return bearerAuth({ token, invalidAuthenticationHeaderMessage: 'Invalid Administrator API Key' })(
		c,
		next
	);
});

// Implementation

// Admin Migration

app.post('/admin/migrate-legacy-keys', async (c) => {
	try {
		const count = await migrateAllLegacyKeys(c.env.KV);
		return c.json({ message: 'Migration completed', migrated_count: count }, 200);
	} catch (err) {
		console.error('Error during legacy key migration:', err);
		return c.text('Failed to migrate legacy keys', 500);
	}
});

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

app.post('/articles/grade', async (c) => {
	const body = await c.req.json<{
		id: string;
		content: string;
	}>();

	if (!body.content) {
		return c.text('Invalid request body', 400);
	}

	const key = `cache:article_score:${body.id}`;
	const score = await tryCache(
		key,
		c.env.CACHE,
		async () => await scoreText(c.env, body.content || '', prompts.articleCriteria),
		60 * 60 * 24 * 14 // scores should not change, cache for article lifetime
	);
	return c.json(score, 200);
});

app.get('/articles/quiz', async (c) => {
	const articleId = normalizeId(c.req.query('articleId') || '');
	if (!articleId) {
		return c.text('Article ID is required', 400);
	}

	const key = `article:quiz:${articleId}`;
	const quizData = await c.env.KV.get<ArticleQuizQuestion[]>(key, 'json');
	if (!quizData) {
		return c.text('Quiz not found for the specified article', 404);
	}

	// Convert correct_answer_index for true/false questions with -1 index
	const processedQuizData = quizData.map((question) => {
		if (question.type === 'true_false') {
			let normalizedIndex = question.correct_answer_index;
			let normalizedAnswer = question.correct_answer;

			// Convert index if it's -1
			if (normalizedIndex === -1) {
				// Use is_true/is_false to determine correct answer
				if (question.is_true) {
					normalizedIndex = 0;
					normalizedAnswer = 'True';
				} else if (question.is_false) {
					normalizedIndex = 1;
					normalizedAnswer = 'False';
				} else {
					// Default to false if no indicators
					normalizedIndex = 1;
					normalizedAnswer = 'False';
				}
			}

			return {
				...question,
				options: ['True', 'False'],
				correct_answer: normalizedAnswer || 'False',
				correct_answer_index: normalizedIndex
			};
		} else if (question.type === 'multiple_choice') {
			// derive correct_answer from options if not provided
			const normalizedAnswer =
				question.correct_answer || question.options[question.correct_answer_index];

			return {
				...question,
				correct_answer: normalizedAnswer
			};
		}
		return question;
	});

	return c.json(processedQuizData, 200);
});

app.get('/articles/quiz/score', async (c) => {
	const userId = normalizeId(c.req.query('userId') || '');
	const articleId = normalizeId(c.req.query('articleId') || '');
	if (!userId || !articleId) {
		return c.text('User ID and Article ID are required', 400);
	}

	const key = `article:quiz_score:${userId}:${articleId}`;
	const data = await c.env.KV.get<{
		score: number;
		scorePercent: number;
		results: {
			question: string;
			correct_answer: string;
			correct_answer_index: number;
			user_answer: string;
			user_answer_index: number;
			correct: boolean;
		}[];
		total: number;
	}>(key, 'json');

	if (!data) {
		return c.text('Quiz score not found for the specified user and article', 404);
	}

	return c.json(data, 200);
});

app.post('/articles/quiz/submit', async (c) => {
	const body = await c.req.json<{
		articleId: string;
		userId: string;
		answers: {
			question: string;
			text: string;
			index: number;
		}[];
	}>();
	if (!body.articleId || !body.userId || !body.answers) {
		return c.text('Article ID and answers are required', 400);
	}

	const userId = normalizeId(body.userId);
	const id = normalizeId(body.articleId);
	const scoreKey = `article:quiz_score:${userId}:${id}`;
	const existingScore = await c.env.KV.get(scoreKey);
	if (existingScore) {
		return c.text('Quiz has already been submitted for this article by the user', 409);
	}

	const key = `article:quiz:${normalizeId(body.articleId)}`;
	const quizData = await c.env.KV.get<ArticleQuizQuestion[]>(key, 'json');
	if (!quizData) {
		return c.text('Quiz not found for the specified article', 404);
	}

	let score = 0;
	const results = [];
	for (const question of quizData) {
		const userAnswer = body.answers.find((a) => a.question === question.question);

		let correct = false;
		let actualCorrectIndex = question.correct_answer_index;
		let actualOptions = question.options;

		// Handle true/false questions
		if (question.type === 'true_false') {
			// Always use ['True', 'False'] for true/false questions
			actualOptions = ['True', 'False'];

			// Convert index if it's -1
			if (actualCorrectIndex === -1) {
				// Use is_true/is_false to determine correct answer
				if (question.is_true) {
					actualCorrectIndex = 0;
				} else if (question.is_false) {
					actualCorrectIndex = 1;
				} else {
					// Default to false if no indicators
					actualCorrectIndex = 1;
				}
			}
		}

		// Standard index-based comparison
		if (userAnswer && userAnswer.index === actualCorrectIndex) {
			correct = true;
			score++;
		}

		results.push({
			question: question.question,
			options: actualOptions,
			correct_answer_index: actualCorrectIndex,
			user_answer_index: userAnswer?.index,
			user_answer: userAnswer?.text,
			correct
		});
	}

	const scorePercent = (score / quizData.length) * 100;

	const data = { score, scorePercent, total: quizData.length, results };
	c.executionCtx.waitUntil(c.env.KV.put(scoreKey, JSON.stringify(data))); // scores are persistent, no expiration

	// increment badge progress
	c.executionCtx.waitUntil(
		addBadgeProgress(body.userId, 'article_quizzes_completed', id, c.env.KV)
	);

	if (data.scorePercent === 100) {
		c.executionCtx.waitUntil(
			addBadgeProgress(body.userId, 'article_quizzes_completed_perfect_score', id, c.env.KV)
		);
	}

	return c.json(data, 200);
});

app.post('/articles/quiz/create', async (c) => {
	const body = await c.req.json<{
		article: Article;
	}>();

	if (!body.article) {
		return c.text('Article is required', 400);
	}

	const quiz = await createArticleQuiz(body.article, c.env.AI);
	if (!quiz || quiz.length === 0) {
		return c.text('Failed to create quiz for the article', 500);
	}

	const key = `article:quiz:${normalizeId(body.article.id)}`;
	c.executionCtx.waitUntil(
		c.env.KV.put(key, JSON.stringify(quiz), { expirationTtl: 60 * 60 * 24 * 14 })
	); // cache for 14 days

	// Convert correct_answer_index for true/false questions with -1 index
	const processedQuiz = quiz.map((question) => {
		if (question.type === 'true_false') {
			let normalizedIndex = question.correct_answer_index;
			let normalizedAnswer = question.correct_answer;

			// Convert index if it's -1
			if (normalizedIndex === -1) {
				// Use is_true/is_false to determine correct answer
				if (question.is_true) {
					normalizedIndex = 0;
					normalizedAnswer = 'True';
				} else if (question.is_false) {
					normalizedIndex = 1;
					normalizedAnswer = 'False';
				} else {
					// Default to false if no indicators
					normalizedIndex = 1;
					normalizedAnswer = 'False';
				}
			}

			return {
				...question,
				options: ['True', 'False'],
				correct_answer: normalizedAnswer || 'False',
				correct_answer_index: normalizedIndex
			};
		} else if (question.type === 'multiple_choice') {
			// Derive correct_answer from options if not provided
			const normalizedAnswer =
				question.correct_answer || question.options[question.correct_answer_index];

			return {
				...question,
				correct_answer: normalizedAnswer
			};
		}
		return question;
	});

	return c.json(processedQuiz, 201);
});

// Prompts

app.post('/prompts/grade', async (c) => {
	const body = await c.req.json<{
		id: string;
		prompt: string;
	}>();

	if (!body.prompt) {
		return c.text('Invalid request body', 400);
	}

	const key = `cache:prompt_score:${body.id}`;
	const score = await tryCache(
		key,
		c.env.CACHE,
		async () => await scoreText(c.env, body.prompt || '', prompts.promptCriteria),
		60 * 60 * 24 * 2 // scores should not change, cache for prompt lifetime
	);
	return c.json(score, 200);
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

	const cacheKey = `user:profile_photo:${id}:${size}`;
	return c.json(
		await tryCache(cacheKey, c.env.CACHE, async () => {
			const photo = await getProfileVariation(id, size, c.env, c.executionCtx);
			if (!photo) {
				return null;
			}
			return { data: toDataURL(photo) };
		}).then((result) => {
			if (!result) {
				return c.text('Profile photo not found', 404);
			}
			return result;
		}),
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

app.post('/users/timer', async (c) => {
	const { action, userId, field } = await c.req.json<{
		action: string;
		userId: string;
		field: string;
	}>();

	if (!action) {
		return c.text('Action is required', 400);
	}

	if (!userId) {
		return c.text('User ID is required', 400);
	}

	if (!field) {
		return c.text('Field is required', 400);
	}

	const id = c.env.TIMER.idFromName(userId);
	const stub = c.env.TIMER.get(id);

	return stub.fetch('https://do/timer', {
		method: 'POST',
		body: JSON.stringify({ action, userId, field }),
		headers: {
			'Content-Type': 'application/json'
		}
	});
});

/// User Journeys

app.get('/users/journey/activity/:id/count', async (c) => {
	const id = c.req.param('id')?.toLowerCase();
	if (!id) {
		return c.text('Journey ID is required', 400);
	}

	if (!/^\d+$/.test(id)) {
		return c.text('Journey ID must be numeric', 400);
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

app.get('/users/journey/:type/leaderboard', async (c) => {
	const type = c.req.param('type')?.toLowerCase();
	if (!type) {
		return c.text('Journey type is required', 400);
	}

	const limit = c.req.query('limit');
	let limit0 = limit ? parseInt(limit, 10) : TOP_LEADERBOARD_COUNT;
	if (isNaN(limit0) || limit0 <= 0) {
		limit0 = TOP_LEADERBOARD_COUNT;
	} else if (limit0 > TOP_LEADERBOARD_COUNT) {
		limit0 = TOP_LEADERBOARD_COUNT;
	}

	try {
		const leaderboard = await retrieveLeaderboard(type, limit0, c.env.KV, c.env.CACHE);
		return c.json(leaderboard, 200);
	} catch (err) {
		console.error(`Error retrieving leaderboard for journey type '${type}':`, err);
		return c.text('Failed to retrieve leaderboard', 500);
	}
});

app.get('/users/journey/:type/:id/rank', async (c) => {
	const id = c.req.param('id')?.toLowerCase();
	const type = c.req.param('type')?.toLowerCase();
	if (!id || !type) {
		return c.text('Journey ID and type are required', 400);
	}

	if (!/^\d+$/.test(id)) {
		return c.text('Journey ID must be numeric', 400);
	}

	if (id.length < 3 || id.length > 50) {
		return c.text('Journey ID must be between 3 and 50 characters', 400);
	}

	try {
		const rank = await retrieveLeaderboardRank(id, type, c.env.KV, c.env.CACHE);
		return c.json({ rank }, 200);
	} catch (err) {
		console.error(`Error retrieving leaderboard rank for journey '${type}' and ID '${id}':`, err);
		return c.text('Failed to retrieve leaderboard rank', 500);
	}
});

app.get('/users/journey/:type/:id', async (c) => {
	const id = c.req.param('id')?.toLowerCase();
	const type = c.req.param('type')?.toLowerCase();
	if (!id || !type) {
		return c.text('Journey ID and type are required', 400);
	}

	if (!/^\d+$/.test(id)) {
		return c.text('Journey ID must be numeric', 400);
	}

	if (id.length < 3 || id.length > 50) {
		return c.text('Journey ID must be between 3 and 50 characters', 400);
	}

	try {
		const [count, lastWrite] = await getJourney(id, type, c.env.KV);
		const rank = await retrieveLeaderboardRank(id, type, c.env.KV, c.env.CACHE);
		return c.json({ count, lastWrite, rank }, 200);
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

	if (!/^\d+$/.test(id)) {
		return c.text('Journey ID must be numeric', 400);
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

	if (!/^\d+$/.test(id)) {
		return c.text('Journey ID must be numeric', 400);
	}

	if (id.length < 3 || id.length > 50) {
		return c.text('Journey ID must be between 3 and 50 characters', 400);
	}

	const [value, lastWrite] = await getJourney(id, type, c.env.KV);
	if (Date.now() - lastWrite < 60 * 60 * 24 * 1000) {
		// Bump expirationTtl
		const normalizedId = normalizeId(id);
		const key = `journey:${type}:${normalizedId}`;
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

	if (!/^\d+$/.test(id)) {
		return c.text('Journey ID must be numeric', 400);
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

/// User Badges

app.get('/users/badges', async (c) => {
	return c.json(
		badges.map(({ progress, ...badge }) => badge),
		200
	);
});

app.get('/users/badges/:id', async (c) => {
	const id = c.req.param('id')?.toLowerCase();
	if (!id) {
		return c.text('User ID is required', 400);
	}

	if (id.length < 3 || id.length > 50) {
		return c.text('User ID must be between 3 and 50 characters', 400);
	}

	try {
		const grantedBadgeIds = await getGrantedBadges(id, c.env.KV);
		const grantedSet = new Set(grantedBadgeIds);

		const allBadges = await Promise.all(
			badges.map(async (badge) => {
				const granted = grantedSet.has(badge.id);
				const metadata = granted ? await getBadgeMetadata(id, badge.id, c.env.KV) : null;
				const progress = await getBadgeProgress(id, badge.id, c.env.KV);

				let granted_at = null;
				if (metadata?.granted_at) {
					granted_at = new Date(metadata.granted_at);
				}

				const { progress: _, ...badgeData } = badge;
				return {
					...badgeData,
					user_id: id,
					granted,
					granted_at,
					progress
				};
			})
		);

		return c.json(allBadges, 200);
	} catch (err) {
		console.error(`Error getting badges for user '${id}':`, err);
		return c.text('Failed to get badges', 500);
	}
});

app.get('/users/badges/:id/:badge_id', async (c) => {
	const id = c.req.param('id')?.toLowerCase();
	const badgeId = c.req.param('badge_id')?.toLowerCase();
	if (!id || !badgeId) {
		return c.text('User ID and Badge ID are required', 400);
	}

	if (id.length < 3 || id.length > 50) {
		return c.text('User ID must be between 3 and 50 characters', 400);
	}

	const badgeData = badges.find((b) => b.id === badgeId);
	if (!badgeData) {
		return c.text('Badge not found', 404);
	}
	const { progress: _, ...badge } = badgeData;

	try {
		const granted = await isBadgeGranted(id, badgeId, c.env.KV);
		const metadata = await getBadgeMetadata(id, badgeId, c.env.KV);
		const progress = await getBadgeProgress(id, badgeId, c.env.KV);

		let granted_at = null;
		if (metadata?.granted_at) {
			granted_at = new Date(metadata.granted_at);
		}

		return c.json(
			{
				...badge,
				user_id: id,
				granted,
				granted_at,
				progress
			},
			200
		);
	} catch (err) {
		console.error(`Error getting badge '${badgeId}' for user '${id}':`, err);
		return c.text('Failed to get badge', 500);
	}
});

app.post('/users/badges/:id/:badge_id/grant', async (c) => {
	const id = c.req.param('id')?.toLowerCase();
	const badgeId = c.req.param('badge_id')?.toLowerCase();
	if (!id || !badgeId) {
		return c.text('User ID and Badge ID are required', 400);
	}

	if (id.length < 3 || id.length > 50) {
		return c.text('User ID must be between 3 and 50 characters', 400);
	}

	const badge = badges.find((b) => b.id === badgeId);
	if (!badge) {
		return c.text('Badge not found', 404);
	}

	// Only allow granting badges without progress function (one-time badges)
	if (badge.progress) {
		return c.text('Cannot manually grant progress-based badges', 400);
	}

	try {
		const alreadyGranted = await isBadgeGranted(id, badgeId, c.env.KV);
		if (alreadyGranted) {
			return c.text('Badge already granted', 409);
		}

		await grantBadge(id, badgeId, c.env.KV);
		const metadata = await getBadgeMetadata(id, badgeId, c.env.KV);

		const { progress: _, ...badgeData } = badge;
		return c.json(
			{
				...badgeData,
				granted: true,
				granted_at: metadata?.granted_at || null,
				progress: 1
			},
			201
		);
	} catch (err) {
		console.error(`Error granting badge '${badgeId}' to user '${id}':`, err);
		return c.text('Failed to grant badge', 500);
	}
});

app.post('/users/badges/:id/track', async (c) => {
	const id = c.req.param('id')?.toLowerCase();
	if (!id) {
		return c.text('User ID is required', 400);
	}

	if (id.length < 3 || id.length > 50) {
		return c.text('User ID must be between 3 and 50 characters', 400);
	}

	const body = await c.req.json<{ tracker_id: string; value: string | string[] | number }>();
	if (!body.tracker_id || body.value === undefined || body.value === null) {
		return c.text('tracker_id and value are required', 400);
	}

	// Validate value type
	if (
		typeof body.value !== 'string' &&
		typeof body.value !== 'number' &&
		!Array.isArray(body.value)
	) {
		return c.text('value must be a string, number, or array of valid types', 400);
	}
	if (
		Array.isArray(body.value) &&
		!body.value.every((v) => typeof v === 'string' || typeof v === 'number')
	) {
		return c.text('value array must contain only strings or numbers', 400);
	}

	try {
		await addBadgeProgress(id, body.tracker_id, body.value, c.env.KV);
		const newlyGranted = await checkAndGrantBadges(id, body.tracker_id, c.env, c.executionCtx);

		return c.json(
			{
				tracker_id: body.tracker_id,
				value: body.value,
				newly_granted: newlyGranted
			},
			200
		);
	} catch (err) {
		console.error(
			`Error tracking progress for tracker '${body.tracker_id}' for user '${id}':`,
			err
		);
		return c.text('Failed to track badge progress', 500);
	}
});

app.post('/users/badges/:id/:badge_id/progress', async (c) => {
	const id = c.req.param('id')?.toLowerCase();
	const badgeId = c.req.param('badge_id')?.toLowerCase();
	if (!id || !badgeId) {
		return c.text('User ID and Badge ID are required', 400);
	}

	if (id.length < 3 || id.length > 50) {
		return c.text('User ID must be between 3 and 50 characters', 400);
	}

	const badge = badges.find((b) => b.id === badgeId);
	if (!badge) {
		return c.text('Badge not found', 404);
	}

	if (!badge.tracker_id) {
		return c.text('Badge does not have a tracker', 400);
	}

	const body = await c.req.json<{ value: string | string[] | number }>();
	if (body.value === undefined || body.value === null) {
		return c.text('Value is required', 400);
	}

	// Validate value type
	if (
		typeof body.value !== 'string' &&
		typeof body.value !== 'number' &&
		!Array.isArray(body.value)
	) {
		return c.text('value must be a string, number, or array of valid types', 400);
	}
	if (
		Array.isArray(body.value) &&
		!body.value.every((v) => typeof v === 'string' || typeof v === 'number')
	) {
		return c.text('value array must contain only strings or numbers', 400);
	}

	try {
		await addBadgeProgress(id, badge.tracker_id, body.value, c.env.KV);
		const progress = await getBadgeProgress(id, badgeId, c.env.KV);

		if (progress >= 1 && !(await isBadgeGranted(id, badgeId, c.env.KV))) {
			await grantBadge(id, badgeId, c.env.KV);
		}

		const granted = await isBadgeGranted(id, badgeId, c.env.KV);
		const metadata = await getBadgeMetadata(id, badgeId, c.env.KV);

		const { progress: _, ...badgeData } = badge;
		return c.json(
			{
				...badgeData,
				user_id: id,
				granted,
				granted_at: metadata?.granted_at || null,
				progress
			},
			200
		);
	} catch (err) {
		console.error(`Error adding progress to badge '${badgeId}' for user '${id}':`, err);
		return c.text('Failed to add badge progress', 500);
	}
});

app.delete('/users/badges/:id/:badge_id/revoke', async (c) => {
	const id = c.req.param('id')?.toLowerCase();
	const badgeId = c.req.param('badge_id')?.toLowerCase();
	if (!id || !badgeId) {
		return c.text('User ID and Badge ID are required', 400);
	}

	if (id.length < 3 || id.length > 50) {
		return c.text('User ID must be between 3 and 50 characters', 400);
	}

	const badge = badges.find((b) => b.id === badgeId);
	if (!badge) {
		return c.text('Badge not found', 404);
	}

	try {
		await revokeBadge(id, badgeId, c.env.KV);
		return c.body(null, 204);
	} catch (err) {
		console.error(`Error revoking badge '${badgeId}' from user '${id}':`, err);
		return c.text('Failed to revoke badge', 500);
	}
});

app.delete('/users/badges/:id/:badge_id/reset', async (c) => {
	const id = c.req.param('id')?.toLowerCase();
	const badgeId = c.req.param('badge_id')?.toLowerCase();
	if (!id || !badgeId) {
		return c.text('User ID and Badge ID are required', 400);
	}

	if (id.length < 3 || id.length > 50) {
		return c.text('User ID must be between 3 and 50 characters', 400);
	}

	const badge = badges.find((b) => b.id === badgeId);
	if (!badge) {
		return c.text('Badge not found', 404);
	}

	try {
		await resetBadgeProgress(id, badgeId, c.env.KV);
		return c.body(null, 204);
	} catch (err) {
		console.error(`Error resetting badge '${badgeId}' for user '${id}':`, err);
		return c.text('Failed to reset badge', 500);
	}
});

/// User Impact Points

app.get('/users/impact_points/:id', async (c) => {
	const id = c.req.param('id')?.toLowerCase();
	if (!id) {
		return c.text('User ID is required', 400);
	}

	if (id.length < 3 || id.length > 50) {
		return c.text('User ID must be between 3 and 50 characters', 400);
	}

	try {
		const points = await getImpactPoints(id, c.env.KV);
		return c.json({ points }, 200);
	} catch (err) {
		console.error(`Error getting impact points for user '${id}':`, err);
		return c.text('Failed to get impact points', 500);
	}
});

app.post('/users/impact_points/:id/add', async (c) => {
	const id = c.req.param('id')?.toLowerCase();
	if (!id) {
		return c.text('User ID is required', 400);
	}

	if (id.length < 3 || id.length > 50) {
		return c.text('User ID must be between 3 and 50 characters', 400);
	}

	const body = await c.req.json<{ points: number }>();
	if (!body.points || body.points <= 0) {
		return c.text('Points must be a positive number', 400);
	}

	try {
		const newPoints = await addImpactPoints(id, body.points, c.env.KV);

		// Track for badge progress
		c.executionCtx.waitUntil(
			addBadgeProgress(id, 'impact_points_earned', newPoints.toString(), c.env.KV)
		);
		c.executionCtx.waitUntil(
			sendUserNotification(
				c.env,
				id,
				'Impact Points Earned',
				`You have earned ${body.points} impact points! Your new total is ${newPoints} points.`,
				undefined,
				'success'
			)
		);

		return c.json({ points: newPoints }, 200);
	} catch (err) {
		console.error(`Error adding impact points for user '${id}':`, err);
		return c.text('Failed to add impact points', 500);
	}
});

app.post('/users/impact_points/:id/remove', async (c) => {
	const id = c.req.param('id')?.toLowerCase();
	if (!id) {
		return c.text('User ID is required', 400);
	}

	if (id.length < 3 || id.length > 50) {
		return c.text('User ID must be between 3 and 50 characters', 400);
	}

	const body = await c.req.json<{ points: number }>();
	if (!body.points || body.points <= 0) {
		return c.text('Points must be a positive number', 400);
	}

	try {
		const newPoints = await removeImpactPoints(id, body.points, c.env.KV);
		return c.json({ points: newPoints }, 200);
	} catch (err) {
		console.error(`Error removing impact points for user '${id}':`, err);
		return c.text('Failed to remove impact points', 500);
	}
});

app.put('/users/impact_points/:id/set', async (c) => {
	const id = c.req.param('id')?.toLowerCase();
	if (!id) {
		return c.text('User ID is required', 400);
	}

	if (id.length < 3 || id.length > 50) {
		return c.text('User ID must be between 3 and 50 characters', 400);
	}

	const body = await c.req.json<{ points: number }>();
	if (typeof body.points !== 'number' || body.points < 0) {
		return c.text('Points must be a non-negative number', 400);
	}

	try {
		await setImpactPoints(id, body.points, c.env.KV);
		return c.json({ points: body.points }, 200);
	} catch (err) {
		console.error(`Error setting impact points for user '${id}':`, err);
		return c.text('Failed to set impact points', 500);
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

	const [image, author] = await getEventThumbnail(id, c.env);
	if (!image) {
		return c.text('Event thumbnail not found', 404);
	}

	return c.body(new Uint8Array(image), 200, {
		'X-Event-Thumbnail-Author': author || 'Unknown',
		'Content-Type': 'image/webp',
		'Content-Length': image.length.toString(),
		'Content-Disposition': `inline; filename="event_${id}_thumbnail.webp"`,
		'Cache-Control': 'public, max-age=31536000, immutable'
	});
});

app.get('/events/thumbnail/:id/metadata', async (c) => {
	const idParam = c.req.param('id');
	if (!idParam || !/^\d+$/.test(idParam)) {
		return c.text('Event ID is required', 400);
	}
	const id = BigInt(idParam);

	if (id <= 0n) {
		return c.text('Invalid Event ID', 400);
	}

	const [image, author] = await getEventThumbnail(id, c.env);
	if (!image) {
		return c.text('Event thumbnail not found', 404);
	}

	return c.json(
		{
			author: author || 'Unknown',
			size: image.length
		},
		200
	);
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

	await uploadEventThumbnail(id, imageData, '<user>', c.env, c.executionCtx);
	return c.body(null, 204);
});

app.post('/events/thumbnail/:id/generate', async (c) => {
	const idParam = c.req.param('id');
	if (!idParam || !/^\d+$/.test(idParam)) {
		return c.text('Event ID is required', 400);
	}
	const id = BigInt(idParam);

	if (id <= 0n) {
		return c.text('Invalid Event ID', 400);
	}

	const name = c.req.query('name')?.trim();
	if (!name || name.length < 3) {
		return c.text('Event name is required to generate thumbnail', 400);
	}

	const location = extractLocationFromEventName(name);
	if (!location) {
		return c.text("Only birthday events (ending with 's Birthday) are allowed", 400);
	}

	const [image, author] = await uploadPlaceThumbnail(location, id, c.env, c.executionCtx);
	if (!image) {
		return c.text('No thumbnail found for specified location', 404);
	}

	return c.body(new Uint8Array(image), 200, {
		'X-Event-Thumbnail-Author': author || 'Unknown',
		'Content-Type': 'image/webp',
		'Content-Length': image.length.toString(),
		'Content-Disposition': `inline; filename="event_${id}_thumbnail.webp"`,
		'Cache-Control': 'public, max-age=31536000, immutable'
	});
});

app.delete('/events/thumbnail/:id', async (c) => {
	const idParam = c.req.param('id');
	if (!idParam || !/^\d+$/.test(idParam)) {
		return c.text('Event ID is required', 400);
	}
	const id = BigInt(idParam);

	if (id <= 0n) {
		return c.text('Invalid Event ID', 400);
	}

	await deleteEventThumbnail(id, c.env, c.executionCtx);
	return c.body(null, 204);
});

app.post('/users/recommend_events', async (c) => {
	const body = await c.req.json<{
		pool: Event[];
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
		return c.text('No events or activities provided', 400);
	}

	if (body.pool.length > 20) {
		return c.text('Event pool cannot exceed 20 events', 400);
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
		.map((e) => e.id)
		.sort()
		.join(',');
	let poolHash = 0;
	for (let i = 0; i < poolIds.length; i++) {
		poolHash = ((poolHash << 5) - poolHash + poolIds.charCodeAt(i)) & 0xffffffff;
	}

	const cacheKey = `cache:recommended_events:${Math.abs(activitiesHash).toString(36)}:${Math.abs(poolHash).toString(36)}:${limit}`;

	return c.json(
		await tryCache(cacheKey, c.env.CACHE, async () => {
			return recommendEvents(body.pool, body.activities, limit, c.env.AI);
		}),
		200
	);
});

app.post('/events/recommend_similar_events', async (c) => {
	const body = await c.req.json<{
		event: Event;
		pool: Event[];
		limit?: number;
	}>();

	if (!body.event || !body.pool) {
		return c.text('Invalid request body', 400);
	}

	if (!Array.isArray(body.pool)) {
		return c.text('Invalid request body format', 400);
	}

	if (body.pool.length === 0) {
		return c.text('No events provided', 400);
	}

	if (body.pool.length > 20) {
		return c.text('Event pool cannot exceed 20 events', 400);
	}

	// default limit is 5, max 10
	const limit = body.limit && body.limit > 0 && body.limit <= 10 ? body.limit : 5;

	// Fast hash to keep cache key under 512 bytes
	const poolIds = body.pool
		.map((e) => e.id)
		.sort()
		.join(',');
	let poolHash = 0;
	for (let i = 0; i < poolIds.length; i++) {
		poolHash = ((poolHash << 5) - poolHash + poolIds.charCodeAt(i)) & 0xffffffff;
	}
	const cacheKey = `cache:similar_events:${body.event.id}:${Math.abs(poolHash).toString(36)}:${limit}`;

	return c.json(
		await tryCache(cacheKey, c.env.CACHE, async () => {
			return recommendSimilarEvents(body.event, body.pool, limit, c.env.AI);
		}),
		200
	);
});

// Event Image Submissions

app.post('/events/submit_image', async (c) => {
	const body = await c.req.json<{ user_id: string; event: Event; photo_url: string }>();
	if (!body || !body.event || !body.photo_url) {
		return c.text('Invalid request body', 400);
	}

	const idParam = body.event.id;
	if (!idParam || !/^\d+$/.test(idParam)) {
		return c.text('Event ID is required', 400);
	}
	const id = BigInt(idParam);
	if (id <= 0n) {
		return c.text('Invalid Event ID', 400);
	}

	if (!body.photo_url.match(/^data:image\/(png|jpeg|webp);base64,/)) {
		return c.text('photo_url must be a data URL with base64-encoded image', 400);
	}

	// Extract base64 data from the data URL and convert to Uint8Array
	const base64Data = body.photo_url.split(',')[1];
	let binaryString: string;
	try {
		binaryString = atob(base64Data);
	} catch (err) {
		return c.text('Invalid base64 image data', 400);
	}

	const len = binaryString.length;
	const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB
	if (len === 0) {
		return c.text('Image data is required', 400);
	}
	if (len > MAX_IMAGE_SIZE) {
		return c.text('Image size exceeds 10MB limit', 413);
	}

	const imageData = new Uint8Array(len);
	for (let i = 0; i < len; i++) {
		imageData[i] = binaryString.charCodeAt(i);
	}

	const userIdParam = body.user_id;
	if (!userIdParam || !/^\d+$/.test(userIdParam)) {
		return c.text('User ID is required', 400);
	}
	const userId = BigInt(userIdParam);
	if (userId <= 0n) {
		return c.text('Invalid User ID', 400);
	}

	// limit to 3 per user - check using lightweight index instead of full data fetch
	const indexKey = `event:${id}:user:${userId}:submission_ids`;
	let userEventSubmissions = await c.env.KV.get<string[]>(indexKey, 'json');
	if (!userEventSubmissions) {
		// fallback: check user's global submission index filtered by event
		const userIndexKey = `user:${userId}:submission_ids`;
		const allUserSubmissions = await c.env.KV.get<string[]>(userIndexKey, 'json');
		if (allUserSubmissions) {
			const eventSubmissionChecks = await Promise.all(
				allUserSubmissions.map(async (sid) => {
					const meta = await c.env.KV.getWithMetadata<{ eventId: string }>(
						`event:submission:${sid}`
					);
					return meta.metadata?.eventId === id.toString() ? sid : null;
				})
			);
			userEventSubmissions = eventSubmissionChecks.filter((s): s is string => s !== null);
		} else {
			userEventSubmissions = [];
		}
	}
	if (userEventSubmissions.length >= 3) {
		return c.text('Submission limit reached for this event', 400);
	}

	const res = await submitEventImage(id, userId, imageData, c.env, c.executionCtx);

	// create submission grade
	c.executionCtx.waitUntil(
		(async () => {
			const [caption, score] = await scoreImage(
				c.env,
				res.image,
				prompts.eventImageCaptionPrompt(body.event),
				prompts.eventImageCriteria(body.event)
			);

			const key = `event:image:score:${id}:${res.id}`;
			const endDate = body.event.end_date || body.event.date;
			await c.env.KV.put(key, JSON.stringify(score), {
				expiration: Math.floor(new Date(endDate).getTime() / 1000) + 60 * 60 * 24 * 3, // 3 days after event end
				metadata: { caption, scored_at: Date.now(), user_id: userId }
			});
		})()
	);

	// track progress for badges
	c.executionCtx.waitUntil(addBadgeProgress(userIdParam, 'event_images_submitted', '1', c.env.KV));

	return c.body(null, 204);
});

app.get('/events/retrieve_image', async (c) => {
	const submissionId = c.req.query('submission_id');
	const eventIdParam = c.req.query('event_id');
	const userIdParam = c.req.query('user_id');

	// Priority 1: submission_id - return single submission with score data
	if (submissionId) {
		if (!/^[0-9a-f]{32}$/i.test(submissionId)) {
			return c.text('Invalid submission_id format', 400);
		}

		const [image, eventId, userId, timestamp] = await getEventImage(submissionId, c.env);
		if (!image || !eventId || !userId || timestamp === null) {
			return c.text('Image not found', 404);
		}

		// Fetch score data with error handling
		const scoreKey = `event:image:score:${eventId}:${submissionId}`;
		const scoreData = await c.env.KV.getWithMetadata<{
			caption: string;
			scored_at: number;
			user_id: string;
		}>(scoreKey);
		let score: ScoreResult | undefined;
		try {
			score = scoreData.value ? (JSON.parse(scoreData.value) as ScoreResult) : undefined;
		} catch (err) {
			console.error(`Failed to parse score data for ${submissionId}:`, err);
			score = undefined;
		}

		return c.json(
			{
				submission_id: submissionId,
				event_id: eventId.toString(),
				user_id: userId.toString(),
				timestamp,
				image: toDataURL(image, 'image/webp'),
				score,
				caption: scoreData.metadata?.caption,
				scored_at: scoreData.metadata?.scored_at
					? new Date(scoreData.metadata.scored_at)
					: undefined
			},
			200
		);
	}

	// Priority 2: event_id and/or user_id - return array of submissions with score data
	if (!eventIdParam && !userIdParam) {
		return c.text('At least one of submission_id, event_id, or user_id is required', 400);
	}

	let eventId: bigint | null = null;
	if (eventIdParam) {
		if (!/^\d+$/.test(eventIdParam)) {
			return c.text('Invalid event_id', 400);
		}
		eventId = BigInt(eventIdParam);
		if (eventId <= 0n) {
			return c.text('Invalid event_id', 400);
		}
	}

	let userId: bigint | null = null;
	if (userIdParam) {
		if (!/^\d+$/.test(userIdParam)) {
			return c.text('Invalid user_id', 400);
		}
		userId = BigInt(userIdParam);
		if (userId <= 0n) {
			return c.text('Invalid user_id', 400);
		}
	}

	// Fetch submissions with image data and scores
	const submissions = await getEventImageSubmissionsWithData(eventId, userId, c.env);

	return c.json(
		{
			items: submissions,
			total: submissions.length
		},
		200
	);
});

app.delete('/events/delete_image', async (c) => {
	const submissionId = c.req.query('submission_id');
	if (!submissionId || submissionId.trim().length === 0) {
		return c.text('submission_id is required', 400);
	}

	if (!/^[0-9a-f]{32}$/i.test(submissionId)) {
		return c.text('Invalid submission_id format', 400);
	}

	const [image, eventId, userId, timestamp] = await getEventImage(submissionId, c.env);
	if (!image || !eventId || !userId || timestamp === null) {
		return c.text('Image not found', 404);
	}

	await deleteEventImageSubmission(eventId, userId, submissionId, c.env, c.executionCtx);
	return c.body(null, 204);
});

app.get('/events/:id/submissions', async (c) => {
	const idParam = c.req.param('id');
	if (!idParam || !/^\d+$/.test(idParam)) {
		return c.text('Event ID is required', 400);
	}
	const id = BigInt(idParam);

	if (id <= 0n) {
		return c.text('Invalid Event ID', 400);
	}

	const submissions = await getEventImageSubmissionsWithData(id, null, c.env);
	return c.json({ items: submissions, total: submissions.length }, 200);
});

app.get('/events/:id/submissions/:userId', async (c) => {
	const idParam = c.req.param('id');
	if (!idParam || !/^\d+$/.test(idParam)) {
		return c.text('Event ID is required', 400);
	}
	const id = BigInt(idParam);

	if (id <= 0n) {
		return c.text('Invalid Event ID', 400);
	}

	const userIdParam = c.req.param('userId');
	if (!userIdParam || !/^\d+$/.test(userIdParam)) {
		return c.text('User ID is required', 400);
	}
	const userId = BigInt(userIdParam);

	const submissions = await getEventImageSubmissionsWithData(id, userId, c.env);
	return c.json({ items: submissions, total: submissions.length }, 200);
});

app.get('/events/:id/submissions/:userId/:submissionId', async (c) => {
	const idParam = c.req.param('id');
	if (!idParam || !/^\d+$/.test(idParam)) {
		return c.text('Event ID is required', 400);
	}
	const id = BigInt(idParam);

	if (id <= 0n) {
		return c.text('Invalid Event ID', 400);
	}

	const userIdParam = c.req.param('userId');
	if (!userIdParam || !/^\d+$/.test(userIdParam)) {
		return c.text('User ID is required', 400);
	}
	const userId = BigInt(userIdParam);

	const submissionId = c.req.param('submissionId');
	if (!submissionId || submissionId.trim().length === 0) {
		return c.text('Submission ID is required', 400);
	}

	if (!/^[0-9a-f]{32}$/i.test(submissionId)) {
		return c.text('Invalid submission_id format', 400);
	}

	// get submission with full data and scores
	const [image, eventId, userIdResult, timestamp] = await getEventImage(submissionId, c.env);
	if (!image || !eventId || !userIdResult || timestamp === null) {
		return c.text('Submission not found', 404);
	}

	// validate eventId and userId match the request params
	if (eventId !== id || userIdResult !== userId) {
		return c.text('Submission not found', 404);
	}

	// Fetch score data with error handling
	const scoreKey = `event:image:score:${eventId}:${submissionId}`;
	const scoreData = await c.env.KV.getWithMetadata<{
		caption: string;
		scored_at: number;
		user_id: string;
	}>(scoreKey);
	let score: ScoreResult | undefined;
	try {
		score = scoreData.value ? (JSON.parse(scoreData.value) as ScoreResult) : undefined;
	} catch (err) {
		console.error(`Failed to parse score data for ${submissionId}:`, err);
		score = undefined;
	}

	return c.json(
		{
			submission_id: submissionId,
			event_id: eventId.toString(),
			user_id: userIdResult.toString(),
			timestamp,
			image: toDataURL(image, 'image/webp'),
			score,
			caption: scoreData.metadata?.caption,
			scored_at: scoreData.metadata?.scored_at ? new Date(scoreData.metadata.scored_at) : undefined
		},
		200
	);
});

app.delete('/events/:id/submissions/:userId/:submissionId', async (c) => {
	const idParam = c.req.param('id');
	if (!idParam || !/^\d+$/.test(idParam)) {
		return c.text('Event ID is required', 400);
	}
	const id = BigInt(idParam);

	if (id <= 0n) {
		return c.text('Invalid Event ID', 400);
	}

	const userIdParam = c.req.param('userId');
	if (!userIdParam || !/^\d+$/.test(userIdParam)) {
		return c.text('User ID is required', 400);
	}
	const userId = BigInt(userIdParam);

	const submissionId = c.req.param('submissionId');
	if (!submissionId || submissionId.trim().length === 0) {
		return c.text('Submission ID is required', 400);
	}

	if (!/^[0-9a-f]{32}$/i.test(submissionId)) {
		return c.text('Invalid submission_id format', 400);
	}

	await deleteEventImageSubmission(id, userId, submissionId, c.env, c.executionCtx);
	return c.body(null, 204);
});

export default app;
