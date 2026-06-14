import { com, kotlin } from '@earth-app/ocean';
import { Hono } from 'hono';

import {
	ArticleQuizQuestion,
	createActivityData,
	createArticleQuiz,
	findArticles,
	recommendArticles,
	recommendEvents,
	recommendSimilarArticles,
	recommendSimilarEvents
} from './content/boat';
import {
	deleteEventThumbnail,
	extractLocationFromEventName,
	getEventThumbnail,
	uploadEventThumbnail,
	uploadPlaceThumbnail
} from './content/thumbnails';
import { getSynonyms } from './util/lang';
import * as prompts from './util/ai';

import { ActivityType, Article, Bindings, Event, ExecutionCtxLike } from './util/types';
import { bearerAuth } from 'hono/bearer-auth';
import {
	toDataURL,
	normalizeId,
	migrateAllLegacyKeys,
	fromDataURL,
	detectAudioFormat,
	batchProcess
} from './util/util';
import {
	getEventImageSubmissionsWithData,
	getEventImage,
	deleteEventImageSubmissions,
	deleteEventImageSubmission,
	submitEventImage
} from './user/submissions';
import { ImageSizes, getProfileVariation, newProfilePhoto } from './user/profile';
import { clearCachePrefix, tryCache } from './util/cache';
import {
	addActivityToJourney,
	getActivityJourney,
	getJourney,
	incrementJourney,
	JOURNEY_TYPES,
	resetJourney,
	retrieveLeaderboard,
	retrieveLeaderboardRank,
	TOP_LEADERBOARD_COUNT
} from './user/journies';
import {
	BadgeTracker,
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
	generateAndStoreMasteryQuest,
	getMasteredMetadata,
	getMasteryQuest,
	isBadgeMastered,
	isMasteryExempt,
	isMasteryLocked,
	listMasteryQuests,
	countActiveMasteryQuests,
	lockActiveMasteryIfApplicable,
	MASTERY_ACTIVE_CAP,
	MASTERY_TTL_SECONDS
} from './user/badges/mastery';
import {
	getImpactPoints,
	addImpactPoints,
	removeImpactPoints,
	setImpactPoints,
	retrievePointsLeaderboard,
	retrievePointsLeaderboardRank,
	TOP_POINTS_LEADERBOARD_COUNT
} from './user/points';
import {
	createOrGetCode,
	getStats as getReferralStats,
	recordClick as recordReferralClick,
	recordConversion
} from './user/referrals';
import {
	createChallenge,
	acceptChallenge,
	declineChallenge,
	getActiveChallengeFor,
	getChallengeFor,
	getChallenge,
	listChallengesForUser
} from './user/challenges';
import { scoreImage, ScoreResult, scoreText } from './content/ferry';
import { sendUserNotification } from './user/notifications';
import { getAllQuests, getQuest, QuestStep } from './user/quests';
import {
	getCurrentQuestProgress,
	getCompletedQuestProgress,
	getQuestHistory,
	QuestStepResponse,
	resetQuestProgress,
	startQuest,
	updateQuestProgress,
	handleQuizQuestStep,
	enrichProgressEntries,
	maybeArchiveCompletedQuest,
	checkStepDelay
} from './user/quests/tracking';
import { API_DEVICE_METADATA, QuestDeviceMetadata } from './user/quests/validation';
import { HTTPException } from 'hono/http-exception';
import {
	AnalyticsCategory,
	AnalyticsCategoryType,
	deleteAnalyticsByOwnerHost,
	deleteContentAnalytics,
	getContentAnalytics,
	getContentAnalyticsByOwner,
	logEvent,
	logTime
} from './content/analytics';
import {
	CustomQuestCreateInput,
	CustomQuestUpdateInput,
	getCustomQuest,
	getCustomQuestsByOwner,
	deleteCustomQuest,
	createCustomQuest,
	updateCustomQuest
} from './user/quests/custom';
import { deleteUserDataVariant, deleteR2Prefix } from './util/deletion';
import {
	OnboardingStepId,
	ONBOARDING_STEPS,
	completeStep as completeOnboardingStep,
	dismissOnboarding,
	getOrCreateOnboarding,
	setPersona,
	resetOnboarding
} from './user/onboarding';
import {
	addToBlacklist,
	isBlacklisted,
	listBlacklist,
	removeFromBlacklist,
	BlacklistKind
} from './admin/blacklist';
import {
	getMoodSnapshot,
	recordMood,
	sanitizeTopic,
	sanitizeDate,
	isValidEmoji,
	EMOJIS
} from './user/mood';
import { bumpSignupFunnel, getAnalyticsSnapshot } from './admin/cf-analytics';
import {
	createReport,
	getReport,
	listReports,
	patchReportStatus,
	deleteReport,
	isReportableContentType,
	isReportReason,
	isReportStatus,
	CreateReportInput
} from './content/reports';
import { getStrikes, addStrike, resetStrikes } from './content/moderation/strikes';
import { moderateReport } from './content/moderation/ai';

const app = new Hono<{ Bindings: Bindings }>();

app.use('*', async (c, next) => {
	const token = c.env.ADMIN_API_KEY;
	return bearerAuth<{ Bindings: Bindings }>({
		token,
		invalidAuthenticationHeaderMessage: 'Invalid Administrator API Key'
	})(c, next);
});

// emit json for every error path cloud can format
app.onError((err, c) => {
	if (err instanceof HTTPException) {
		const status = err.status;
		return c.json({ message: err.message || 'Request failed', code: status }, status);
	}

	console.error('Unhandled error in cloud worker:', err);
	const message = err instanceof Error && err.message ? err.message : 'Internal Server Error';
	return c.json({ message, code: 500 }, 500);
});

// Implementation

// Content Reports + Moderation Strikes
// internal endpoints — mantle2 proxies user/admin traffic here; all routes share the admin key

app.post('/reports', async (c) => {
	let body: CreateReportInput;
	try {
		body = await c.req.json<CreateReportInput>();
	} catch {
		return c.text('Invalid request body', 400);
	}

	if (!isReportableContentType(body.content_type)) {
		return c.text('Invalid content_type', 400);
	}
	if (body.content_id === undefined || body.content_id === null || `${body.content_id}` === '') {
		return c.text('content_id is required', 400);
	}
	if (!isReportReason(body.reason)) {
		return c.text('Invalid reason', 400);
	}

	const { report, deduped } = await createReport(c.env, {
		content_type: body.content_type,
		content_id: String(body.content_id),
		parent_id: body.parent_id != null ? String(body.parent_id) : undefined,
		content_owner_id: body.content_owner_id != null ? String(body.content_owner_id) : undefined,
		reason: body.reason,
		description: body.description,
		reporter_id: body.reporter_id ?? null,
		reporter_ip_hash: body.reporter_ip_hash,
		source: body.source === 'ai' ? 'ai' : 'user',
		ai: body.ai
	});

	// ai triage + best-effort auto-remove run in the background so the report POST stays fast
	if (!deduped && report.source === 'user') {
		c.executionCtx.waitUntil(moderateReport(c.env, report.id));
	}

	return c.json({ report, deduped }, 201);
});

app.get('/reports', async (c) => {
	const statusParam = c.req.query('status') || 'pending';
	if (!isReportStatus(statusParam)) {
		return c.text('Invalid status', 400);
	}

	const limitRaw = parseInt(c.req.query('limit') || '50', 10);
	const limit = isNaN(limitRaw) || limitRaw <= 0 ? 50 : Math.min(limitRaw, 100);
	const cursor = c.req.query('cursor') || undefined;

	const result = await listReports(c.env, statusParam, limit, cursor);
	return c.json(result, 200);
});

app.get('/reports/:id', async (c) => {
	const report = await getReport(c.env, c.req.param('id'));
	if (!report) {
		return c.text('Report not found', 404);
	}
	return c.json(report, 200);
});

app.patch('/reports/:id', async (c) => {
	const id = c.req.param('id');
	let body: { status?: string; reviewed_by?: string; action_notes?: string };
	try {
		body = await c.req.json();
	} catch {
		return c.text('Invalid request body', 400);
	}

	if (!body.status || !isReportStatus(body.status)) {
		return c.text('Invalid status', 400);
	}

	const updated = await patchReportStatus(
		c.env,
		id,
		body.status,
		body.reviewed_by,
		body.action_notes
	);
	if (!updated) {
		return c.text('Report not found', 404);
	}
	return c.json(updated, 200);
});

app.delete('/reports/:id', async (c) => {
	const ok = await deleteReport(c.env, c.req.param('id'));
	if (!ok) {
		return c.text('Report not found', 404);
	}
	return c.body(null, 204);
});

app.get('/users/:id/strikes', async (c) => {
	const id = normalizeId(c.req.param('id') || '');
	if (!id) {
		return c.text('User ID is required', 400);
	}
	return c.json(await getStrikes(c.env, id), 200);
});

app.post('/users/:id/strikes', async (c) => {
	const id = normalizeId(c.req.param('id') || '');
	if (!id) {
		return c.text('User ID is required', 400);
	}

	let body: { content_type?: string; content_id?: string; reason?: string; source?: string };
	try {
		body = await c.req.json();
	} catch {
		return c.text('Invalid request body', 400);
	}

	if (!isReportableContentType(body.content_type)) {
		return c.text('Invalid content_type', 400);
	}
	if (!body.content_id) {
		return c.text('content_id is required', 400);
	}
	if (!isReportReason(body.reason)) {
		return c.text('Invalid reason', 400);
	}

	const { strikes, action } = await addStrike(c.env, id, {
		content_type: body.content_type,
		content_id: String(body.content_id),
		reason: body.reason,
		source: body.source === 'ai' ? 'ai' : 'user'
	});

	return c.json({ strikes, action }, 200);
});

app.post('/users/:id/strikes/reset', async (c) => {
	const id = normalizeId(c.req.param('id') || '');
	if (!id) {
		return c.text('User ID is required', 400);
	}
	return c.json(await resetStrikes(c.env, id), 200);
});

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

// Analytics + Timer

app.post('/users/timer', async (c) => {
	let body: {
		action?: string;
		userId?: string;
		field?: string;
		metadata?: Record<string, any>;
		rank?: string;
	};

	try {
		body = await c.req.json<{
			action?: string;
			userId?: string;
			field?: string;
			metadata?: Record<string, any>;
			rank?: string;
		}>();
	} catch {
		return c.text('Invalid request body', 400);
	}

	const action = typeof body.action === 'string' ? body.action.trim() : '';
	const userId = typeof body.userId === 'string' ? body.userId.trim() : '';
	const field = typeof body.field === 'string' ? body.field.trim() : '';
	const metadata =
		body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
			? body.metadata
			: undefined;
	const rank = normalizeQuestRank(body.rank) ?? undefined;

	if (!action) {
		return c.text('Action is required', 400);
	}

	if (action !== 'start' && action !== 'stop') {
		return c.text('Invalid action', 400);
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
		body: JSON.stringify({ action, userId, field, metadata, rank }),
		headers: {
			'Content-Type': 'application/json'
		}
	});
});

app.get('/content_analytics/individual/:id', async (c) => {
	const id = c.req.param('id');
	if (!id) {
		return c.text('Content ID is required', 400);
	}

	const analytics = await getContentAnalytics(id, c.env);
	return c.json(analytics, 200);
});

app.get('/content_analytics/user/:id', async (c) => {
	const id = normalizeId(c.req.param('id') || '');
	if (!id) {
		return c.text('User ID is required', 400);
	}

	try {
		const analytics = await getContentAnalyticsByOwner(id, c.env);
		return c.json(analytics, 200);
	} catch (err) {
		console.error(`Error getting content analytics for user '${id}':`, err);
		return c.text('Failed to get content analytics', 500);
	}
});

app.post('/content_analytics/log_event', async (c) => {
	type EventAnalyticsRequest = {
		category?: AnalyticsCategoryType;
		contentId?: string;
		ownerHost?: string;
		userId?: string;
		value?: number;
		metadata?: Record<string, any>;
	};

	let body: EventAnalyticsRequest;

	try {
		body = await c.req.json<EventAnalyticsRequest>();
	} catch {
		return c.text('Invalid request body', 400);
	}

	const category = body.category;
	const contentId = typeof body.contentId === 'string' ? body.contentId.trim() : '';
	const userId = typeof body.userId === 'string' ? body.userId.trim() : '';
	const metadata =
		body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
			? body.metadata
			: undefined;
	const ownerHost = typeof body.ownerHost === 'string' ? body.ownerHost.trim() : undefined;

	if (!category) {
		return c.text('Category is required', 400);
	}

	if (Object.values(AnalyticsCategory).indexOf(category as AnalyticsCategory) === -1) {
		return c.text(`Invalid category: ${category}`, 400);
	}

	if (!contentId) {
		return c.text('Content ID is required', 400);
	}

	if (!userId) {
		return c.text('User ID is required', 400);
	}

	await logEvent(category, contentId, userId, metadata, c.env, { ownerHost });
	return c.text('Event logged successfully', 201);
});

app.post('/content_analytics/log_time', async (c) => {
	type TimeAnalyticsRequest = {
		category?: AnalyticsCategoryType;
		contentId?: string;
		ownerHost?: string;
		userId?: string;
		seconds?: number;
		metadata?: Record<string, any>;
	};

	let body: TimeAnalyticsRequest;
	try {
		body = await c.req.json<TimeAnalyticsRequest>();
	} catch {
		return c.text('Invalid request body', 400);
	}

	const category = body.category;
	const contentId = typeof body.contentId === 'string' ? body.contentId.trim() : '';
	const userId = typeof body.userId === 'string' ? body.userId.trim() : '';
	const seconds = typeof body.seconds === 'number' ? body.seconds : undefined;
	const metadata =
		body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
			? body.metadata
			: undefined;
	const ownerHost = typeof body.ownerHost === 'string' ? body.ownerHost.trim() : undefined;

	if (!category) {
		return c.text('Category is required', 400);
	}

	if (Object.values(AnalyticsCategory).indexOf(category as AnalyticsCategory) === -1) {
		return c.text(`Invalid category: ${category}`, 400);
	}

	if (!contentId) {
		return c.text('Content ID is required', 400);
	}

	if (!userId) {
		return c.text('User ID is required', 400);
	}

	if (seconds === undefined) {
		return c.text('Seconds is required', 400);
	}

	await logTime(category, contentId, userId, seconds, metadata, c.env, { ownerHost });
	return c.text('Time logged successfully', 201);
});

app.delete('/content_analytics/delete', async (c) => {
	const contentId = c.req.query('content_id');
	const ownerHost = c.req.query('owner_host');

	if (contentId) {
		if (typeof contentId !== 'string') {
			return c.text('content_id must be a string', 400);
		}

		await deleteContentAnalytics(contentId, c.env);
		return c.text(`Content analytics deleted successfully: ID ${contentId}`, 200);
	}

	if (ownerHost) {
		if (typeof ownerHost !== 'string') {
			return c.text('owner_host must be a string', 400);
		}

		await deleteAnalyticsByOwnerHost(ownerHost, c.env);
		return c.text(`Content analytics deleted successfully for owner_host: ${ownerHost}`, 200);
	}

	return c.text('Either content_id or owner_host query parameter is required', 400);
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

	if (!body || !body.article || !Array.isArray(body.pool)) {
		return c.text('Invalid request body', 400);
	}

	body.pool = body.pool.filter((a) => a && a.id && a.title && a.content).slice(0, 20);

	if (body.pool.length === 0) {
		return c.json([], 200);
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

	const processedQuizData = quizData.map((question) => {
		if (question.type === 'true_false') {
			let normalizedIndex = question.correct_answer_index;
			let normalizedAnswer = question.correct_answer;

			if (normalizedIndex === -1) {
				if (question.is_true) {
					normalizedIndex = 0;
					normalizedAnswer = 'True';
				} else if (question.is_false) {
					normalizedIndex = 1;
					normalizedAnswer = 'False';
				} else {
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
		}

		if (question.type === 'multiple_choice') {
			const normalizedAnswer =
				question.correct_answer || question.options[question.correct_answer_index];

			return { ...question, correct_answer: normalizedAnswer };
		}

		if (question.type === 'multi_select') {
			// strip correct_answers/correct_answer_indices so the client can't read the answer key
			const { correct_answers: _ca, correct_answer_indices: _i, ...rest } = question;
			void _ca;
			void _i;
			return rest;
		}

		if (question.type === 'order') {
			// items[] stored on the server is the canonical correct order — shuffle for the wire so
			// the answer doesn't leak. server validates against the canonical copy on submit.
			const shuffled = [...question.items].sort(() => Math.random() - 0.5);
			return { ...question, items: shuffled };
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
		articleTypes: ActivityType[];
		userId: string;
		answers: {
			question: string;
			// single-pick: multiple_choice / true_false
			text?: string;
			index?: number;
			// multi_select
			texts?: string[];
			indices?: number[];
			// order — sequence of item strings the user submitted
			ordered?: string[];
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

	const arraysEqual = (a: readonly string[], b: readonly string[]): boolean =>
		a.length === b.length && a.every((v, i) => v === b[i]);
	const setsEqual = (a: readonly number[], b: readonly number[]): boolean => {
		if (a.length !== b.length) return false;
		const sa = [...a].sort((x, y) => x - y);
		const sb = [...b].sort((x, y) => x - y);
		return sa.every((v, i) => v === sb[i]);
	};

	let score = 0;
	const results: any[] = [];
	for (const question of quizData) {
		const userAnswer = body.answers.find((a) => a.question === question.question);
		let correct = false;

		if (question.type === 'multi_select') {
			const correctIdx = Array.isArray(question.correct_answer_indices)
				? question.correct_answer_indices
				: [];
			const userIdx = Array.isArray(userAnswer?.indices) ? userAnswer!.indices! : [];
			correct = correctIdx.length > 0 && setsEqual(correctIdx, userIdx);
			if (correct) score++;

			results.push({
				question: question.question,
				type: 'multi_select',
				options: question.options,
				correct_answers:
					question.correct_answers ?? correctIdx.map((i) => question.options[i] ?? ''),
				correct_answer_indices: correctIdx,
				user_answers: userAnswer?.texts ?? [],
				user_answer_indices: userIdx,
				correct
			});
			continue;
		}

		if (question.type === 'order') {
			const correctOrder = Array.isArray(question.items) ? question.items : [];
			const userOrder = Array.isArray(userAnswer?.ordered) ? userAnswer!.ordered! : [];
			correct = correctOrder.length > 0 && arraysEqual(correctOrder, userOrder);
			if (correct) score++;

			results.push({
				question: question.question,
				type: 'order',
				correct_order: correctOrder,
				user_order: userOrder,
				correct
			});
			continue;
		}

		// existing single-pick path: multiple_choice + true_false
		let actualCorrectIndex = question.correct_answer_index;
		let actualOptions = question.options;

		if (question.type === 'true_false') {
			actualOptions = ['True', 'False'];
			if (actualCorrectIndex === -1) {
				if (question.is_true) {
					actualCorrectIndex = 0;
				} else if (question.is_false) {
					actualCorrectIndex = 1;
				} else {
					actualCorrectIndex = 1;
				}
			}
		}

		if (userAnswer && userAnswer.index === actualCorrectIndex) {
			correct = true;
			score++;
		}

		results.push({
			question: question.question,
			type: question.type,
			options: actualOptions,
			correct_answer_index: actualCorrectIndex,
			user_answer_index: userAnswer?.index,
			user_answer: userAnswer?.text,
			correct
		});
	}

	const scorePercent = (score / quizData.length) * 100;

	const data = { score, scorePercent, total: quizData.length, results };
	// score must be written before returning so that quest validation can read it from KV
	await c.env.KV.put(scoreKey, JSON.stringify(data)); // scores are persistent, no expiration

	c.executionCtx.waitUntil(
		Promise.all([
			// increment badge progress
			addBadgeProgress(userId, 'article_quizzes_completed', id, c.env.KV),

			// handle article_quiz quest steps
			handleQuizQuestStep(userId, scoreKey, scorePercent, body.articleTypes, c.env, c.executionCtx)
		])
	);

	if (data.scorePercent === 100) {
		c.executionCtx.waitUntil(
			addBadgeProgress(body.userId, 'article_quizzes_completed_perfect_score', id, c.env.KV)
		);
	}

	return c.json(data, 200);
});

app.post('/articles/quiz/create', async (c) => {
	let body: { article: Article };
	try {
		body = await c.req.json<{ article: Article }>();
	} catch {
		return c.text('Invalid JSON body', 400);
	}

	if (!body.article) {
		return c.text('Article is required', 400);
	}

	const quiz = await createArticleQuiz(body.article, c.env.AI);
	if (!quiz || quiz.length === 0) {
		// not a server fault — the model produced no quiz (usually too little usable content).
		// 422 so the caller can distinguish "couldn't generate" from a crash and message accordingly.
		return c.text(
			'Could not generate a quiz from this article. The content may be too short.',
			422
		);
	}

	const key = `article:quiz:${normalizeId(body.article.id)}`;
	await c.env.KV.put(key, JSON.stringify(quiz), { expirationTtl: 60 * 60 * 24 * 14 }); // cache for 14 days

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

// serves both create + update
app.post('/articles/quiz/create_manual', async (c) => {
	const body = await c.req.json<{
		articleId: string;
		quiz: ArticleQuizQuestion[];
	}>();

	if (!body.articleId || !body.quiz) {
		return c.text('Article ID and quiz are required', 400);
	}

	if (!Array.isArray(body.quiz) || body.quiz.length === 0) {
		return c.text('Quiz must be a non-empty array of questions', 400);
	}

	// strict per-type shape validation
	for (let i = 0; i < body.quiz.length; i++) {
		const q = body.quiz[i] as ArticleQuizQuestion | undefined;
		if (!q || typeof q.question !== 'string' || q.question.trim().length === 0) {
			return c.text(`Question at index ${i} is missing question text`, 400);
		}
		const t = (q as any).type;
		if (t === 'multiple_choice') {
			const opts = (q as any).options;
			if (!Array.isArray(opts) || opts.length < 2 || opts.length > 6) {
				return c.text(`multiple_choice at ${i} needs 2-6 options`, 400);
			}
			const idx = (q as any).correct_answer_index;
			if (typeof idx !== 'number' || idx < 0 || idx >= opts.length) {
				return c.text(`multiple_choice at ${i} has out-of-range correct_answer_index`, 400);
			}
		} else if (t === 'multi_select') {
			const opts = (q as any).options;
			if (!Array.isArray(opts) || opts.length < 3 || opts.length > 6) {
				return c.text(`multi_select at ${i} needs 3-6 options`, 400);
			}
			const ci = (q as any).correct_answer_indices;
			if (!Array.isArray(ci) || ci.length < 1 || ci.length >= opts.length) {
				return c.text(`multi_select at ${i} needs 1..(options-1) correct_answer_indices`, 400);
			}
			for (const v of ci) {
				if (typeof v !== 'number' || v < 0 || v >= opts.length) {
					return c.text(`multi_select at ${i} has out-of-range correct_answer_indices`, 400);
				}
			}
		} else if (t === 'true_false') {
			const idx = (q as any).correct_answer_index;
			if (typeof idx !== 'number' || (idx !== 0 && idx !== 1 && idx !== -1)) {
				return c.text(`true_false at ${i} needs correct_answer_index 0/1/-1`, 400);
			}
		} else if (t === 'order') {
			const items = (q as any).items;
			if (!Array.isArray(items) || items.length < 3 || items.length > 6) {
				return c.text(`order at ${i} needs 3-6 items`, 400);
			}
			for (const item of items) {
				if (typeof item !== 'string' || item.trim().length === 0) {
					return c.text(`order at ${i} has empty items`, 400);
				}
			}
		} else {
			return c.text(`Unknown question type at ${i}: ${t}`, 400);
		}
	}

	const key = `article:quiz:${normalizeId(body.articleId)}`;
	await c.env.KV.put(key, JSON.stringify(body.quiz)); // no expiration, quiz is persistent

	return c.json({ message: 'Quiz created or updated successfully' }, 201);
});

app.delete('/articles/quiz/delete', async (c) => {
	const { articleId } = await c.req.json<{ articleId: string }>();
	if (!articleId) {
		return c.text('Article ID is required', 400);
	}

	const key = `article:quiz:${normalizeId(articleId)}`;
	await c.env.KV.delete(key);

	return c.json({ message: 'Quiz deleted successfully' }, 200);
});

// Users

app.delete('/users/:id', async (c) => {
	const id = c.req.param('id')?.trim();
	if (!id) {
		return c.text('User ID is required', 400);
	}

	if (!/^\d+$/.test(id)) {
		return c.text('User ID must be numeric', 400);
	}

	const id0 = normalizeId(id);
	const intId = BigInt(id0);

	if (intId <= 0n) {
		return c.text('Invalid User ID', 400);
	}

	if (intId === 1n) {
		return c.text('Cannot delete admin user', 400);
	}

	const variants = Array.from(new Set([id0, id]));

	c.executionCtx.waitUntil(
		(async () => {
			try {
				await Promise.all(
					variants.map((variant) => deleteUserDataVariant(variant, intId, c.env, c.executionCtx))
				);

				// remove any profile/quest blobs written under users/<id>/ in R2
				await Promise.all(
					variants.map(async (variant) => {
						await deleteR2Prefix(c.env.R2, `users/${variant}/`);
					})
				);
			} catch (err) {
				console.error(`Failed deleting user data for '${id0}':`, err);
			}
		})()
	);

	return c.json({ message: 'User data deletion initiated' }, 200);
});

app.post('/users/recommend_activities', async (c) => {
	const body = await c.req.json<{
		all: {
			type: 'com.earthapp.activity.Activity';
			id: string;
			name: string;
			description: string;
			aliases: string[];
			activity_types: ActivityType[];
		}[];
		user: {
			type: 'com.earthapp.activity.Activity';
			id: string;
			name: string;
			description: string;
			aliases: string[];
			activity_types: ActivityType[];
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

	let photo: Uint8Array;
	try {
		photo = await newProfilePhoto(body, id, c.env, c.executionCtx);
	} catch (err) {
		// mantle2 reads { message } via extractCloudMessage; keep shape consistent with other error JSON
		const message = err instanceof Error ? err.message : 'Failed to update profile photo';
		return c.json({ message }, 500);
	}

	if (!photo) {
		return c.json({ message: 'Failed to update profile photo' }, 500);
	}

	return c.json({ data: toDataURL(photo) });
});

app.post('/users/recommend_articles', async (c) => {
	const body = await c.req.json<{
		pool: Article[];
		activities: string[];
		limit?: number;
	}>();

	if (!body || !Array.isArray(body.pool) || !Array.isArray(body.activities)) {
		return c.text('Invalid request body', 400);
	}

	// be forgiving: clean inputs instead of rejecting so partial/imperfect data still gets a result
	body.pool = body.pool.filter((a) => a && a.id && a.title && a.content).slice(0, 20);
	body.activities = body.activities
		.filter((a) => typeof a === 'string' && a.trim().length > 0)
		.slice(0, 10);

	if (body.pool.length === 0 || body.activities.length === 0) {
		return c.json([], 200);
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

	if (type.length < 3 || type.length > 50) {
		return c.text('Journey type must be between 3 and 50 characters', 400);
	}

	if (!JOURNEY_TYPES.includes(type)) {
		return c.text(`Invalid journey type. Valid types are: ${JOURNEY_TYPES.join(', ')}`, 400);
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

	if (type.length < 3 || type.length > 50) {
		return c.text('Journey type must be between 3 and 50 characters', 400);
	}

	if (!JOURNEY_TYPES.includes(type)) {
		return c.text(`Invalid journey type. Valid types are: ${JOURNEY_TYPES.join(', ')}`, 400);
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

	if (type.length < 3 || type.length > 50) {
		return c.text('Journey type must be between 3 and 50 characters', 400);
	}

	if (!JOURNEY_TYPES.includes(type)) {
		return c.text(`Invalid journey type. Valid types are: ${JOURNEY_TYPES.join(', ')}`, 400);
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

	if (type.length < 3 || type.length > 50) {
		return c.text('Journey type must be between 3 and 50 characters', 400);
	}

	if (!JOURNEY_TYPES.includes(type)) {
		return c.text(`Invalid journey type. Valid types are: ${JOURNEY_TYPES.join(', ')}`, 400);
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
		const newCount = await incrementJourney(id, type, c.env.KV, c.executionCtx, c.env.CACHE);
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

	if (type.length < 3 || type.length > 50) {
		return c.text('Journey type must be between 3 and 50 characters', 400);
	}

	if (!JOURNEY_TYPES.includes(type)) {
		return c.text(`Invalid journey type. Valid types are: ${JOURNEY_TYPES.join(', ')}`, 400);
	}

	try {
		await resetJourney(id, type, c.env.KV, c.env.CACHE);
		return c.body(null, 204);
	} catch (err) {
		console.error(`Error resetting journey '${type}' for ID '${id}':`, err);
		return c.text('Failed to reset journey', 500);
	}
});

/// User Badges

app.get('/users/badges', async (c) => {
	return c.json(
		badges.map(({ progress, ...badge }) => ({
			...badge,
			mastery_exempt: isMasteryExempt(badge.id)
		})),
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

	if (!/^\d+$/.test(id)) {
		return c.text('User ID must be numeric', 400);
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

				const masteredMeta = granted ? await getMasteredMetadata(id, badge.id, c.env.KV) : null;
				const mastered_at = masteredMeta?.mastered_at ? new Date(masteredMeta.mastered_at) : null;

				const { progress: _, ...badgeData } = badge;
				return {
					...badgeData,
					user_id: id,
					granted,
					granted_at,
					progress,
					mastered: mastered_at !== null,
					mastered_at,
					mastery_exempt: isMasteryExempt(badge.id)
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

	if (!/^\d+$/.test(id)) {
		return c.text('User ID must be numeric', 400);
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

		const masteredMeta = granted ? await getMasteredMetadata(id, badgeId, c.env.KV) : null;
		const mastered_at = masteredMeta?.mastered_at ? new Date(masteredMeta.mastered_at) : null;

		return c.json(
			{
				...badge,
				user_id: id,
				granted,
				granted_at,
				progress,
				mastered: mastered_at !== null,
				mastered_at,
				mastery_exempt: isMasteryExempt(badgeId)
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

	if (!/^\d+$/.test(id)) {
		return c.text('User ID must be numeric', 400);
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

	if (!/^\d+$/.test(id)) {
		return c.text('User ID must be numeric', 400);
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

	if (body.tracker_id.length < 3 || body.tracker_id.length > 50) {
		return c.text('tracker_id must be between 3 and 50 characters', 400);
	}

	if (!badges.some((b) => b.tracker_id === body.tracker_id)) {
		return c.text('tracker_id not associated with any badge', 400);
	}

	const trackerId = body.tracker_id as BadgeTracker;

	try {
		await addBadgeProgress(id, trackerId, body.value, c.env.KV);
		const newlyGranted = await checkAndGrantBadges(id, trackerId, c.env, c.executionCtx);

		return c.json(
			{
				tracker_id: trackerId,
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

	if (!/^\d+$/.test(id)) {
		return c.text('User ID must be numeric', 400);
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

	if (!/^\d+$/.test(id)) {
		return c.text('User ID must be numeric', 400);
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

	if (!/^\d+$/.test(id)) {
		return c.text('User ID must be numeric', 400);
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

/// Badge Mastery

app.get('/users/badges/:id/:badge_id/mastery', async (c) => {
	const id = c.req.param('id')?.toLowerCase();
	const badgeId = c.req.param('badge_id')?.toLowerCase();
	if (!id || !badgeId) {
		return c.text('User ID and Badge ID are required', 400);
	}

	if (id.length < 3 || id.length > 50) {
		return c.text('User ID must be between 3 and 50 characters', 400);
	}

	if (!/^\d+$/.test(id)) {
		return c.text('User ID must be numeric', 400);
	}

	const badge = badges.find((b) => b.id === badgeId);
	if (!badge) {
		return c.text('Badge not found', 404);
	}

	if (isMasteryExempt(badgeId)) {
		return c.json(
			{
				user_id: id,
				badge_id: badgeId,
				exempt: true,
				generated: false,
				locked: false,
				mastered: false,
				mastered_at: null,
				quest: null
			},
			200
		);
	}

	try {
		const [locked, masteredMeta, quest] = await Promise.all([
			isMasteryLocked(id, badgeId, c.env.KV),
			getMasteredMetadata(id, badgeId, c.env.KV),
			getMasteryQuest(id, badgeId, c.env.KV)
		]);

		return c.json(
			{
				user_id: id,
				badge_id: badgeId,
				exempt: false,
				generated: quest !== null,
				locked,
				mastered: masteredMeta !== null,
				mastered_at: masteredMeta?.mastered_at ? new Date(masteredMeta.mastered_at) : null,
				quest
			},
			200
		);
	} catch (err) {
		console.error(`Error getting mastery status for badge '${badgeId}' user '${id}':`, err);
		return c.text('Failed to get mastery status', 500);
	}
});

app.post('/users/badges/:id/:badge_id/mastery/generate', async (c) => {
	const id = c.req.param('id')?.toLowerCase();
	const badgeId = c.req.param('badge_id')?.toLowerCase();
	if (!id || !badgeId) {
		return c.text('User ID and Badge ID are required', 400);
	}

	if (id.length < 3 || id.length > 50) {
		return c.text('User ID must be between 3 and 50 characters', 400);
	}

	if (!/^\d+$/.test(id)) {
		return c.text('User ID must be numeric', 400);
	}

	const badge = badges.find((b) => b.id === badgeId);
	if (!badge) {
		return c.text('Badge not found', 404);
	}

	if (isMasteryExempt(badgeId)) {
		return c.text('This badge does not support mastery quests', 400);
	}

	let body: prompts.UserProfilePromptData;
	try {
		body = await c.req.json<prompts.UserProfilePromptData>();
	} catch {
		return c.text('Request body must be valid JSON matching UserProfilePromptData', 400);
	}

	if (!body || typeof body.username !== 'string' || !Array.isArray(body.activities)) {
		return c.text('Request body must include username and activities[]', 400);
	}

	// Preconditions: badge must be granted, not already locked, not already mastered,
	// no existing quest, and the user must be under the active-mastery cap.
	const [granted, locked, alreadyMastered, existing, activeCount] = await Promise.all([
		isBadgeGranted(id, badgeId, c.env.KV),
		isMasteryLocked(id, badgeId, c.env.KV),
		isBadgeMastered(id, badgeId, c.env.KV),
		getMasteryQuest(id, badgeId, c.env.KV),
		countActiveMasteryQuests(id, c.env.KV)
	]);

	if (!granted) {
		return c.text('Badge must be granted before mastery can be generated', 409);
	}
	if (locked) {
		return c.text('Mastery for this badge has been permanently locked', 410);
	}
	if (alreadyMastered) {
		return c.text('Badge has already been mastered', 409);
	}
	if (existing) {
		return c.text(
			'Mastery quest has already been generated; start it instead of regenerating',
			409
		);
	}
	if (activeCount >= MASTERY_ACTIVE_CAP) {
		return c.text(
			`Active mastery cap reached (${MASTERY_ACTIVE_CAP}); complete or wait for an existing quest to expire`,
			429
		);
	}

	try {
		const quest = await generateAndStoreMasteryQuest(id, badge, body, c.env);
		return c.json(quest, 201);
	} catch (err) {
		console.error(`Error generating mastery quest for badge '${badgeId}' user '${id}':`, err);
		return c.text('Failed to generate mastery quest', 500);
	}
});

app.get('/users/:id/badges/masteries', async (c) => {
	const id = c.req.param('id')?.toLowerCase();
	if (!id) return c.text('User ID is required', 400);
	if (id.length < 3 || id.length > 50)
		return c.text('User ID must be between 3 and 50 characters', 400);
	if (!/^\d+$/.test(id)) return c.text('User ID must be numeric', 400);

	try {
		const items = await listMasteryQuests(id, c.env.KV);
		const active = items.filter((i) => !i.mastered).length;
		return c.json(
			{
				cap: MASTERY_ACTIVE_CAP,
				active,
				ttl_seconds: MASTERY_TTL_SECONDS,
				items
			},
			200
		);
	} catch (err) {
		console.error(`Error listing masteries for user '${id}':`, err);
		return c.text('Failed to list masteries', 500);
	}
});

/// User Referrals

app.get('/users/referral/:id', async (c) => {
	const id = c.req.param('id')?.toLowerCase();
	if (!id || !/^\d+$/.test(id)) {
		return c.text('User ID must be numeric', 400);
	}

	try {
		const code = await createOrGetCode(c.env, id);
		return c.json({ code }, 200);
	} catch (err) {
		console.error(`Error getting referral code for user '${id}':`, err);
		return c.text('Failed to get referral code', 500);
	}
});

app.get('/users/referral/:id/stats', async (c) => {
	const id = c.req.param('id')?.toLowerCase();
	if (!id || !/^\d+$/.test(id)) {
		return c.text('User ID must be numeric', 400);
	}

	try {
		const stats = await getReferralStats(c.env, id);
		return c.json(stats, 200);
	} catch (err) {
		console.error(`Error getting referral stats for user '${id}':`, err);
		return c.text('Failed to get referral stats', 500);
	}
});

app.post('/users/referral/click', async (c) => {
	const body = await c.req.json<{ code?: string }>().catch(() => ({}) as { code?: string });
	const code = body.code?.trim();
	if (!code) return c.json({ ok: false }, 200);

	// best-effort; never block the caller
	c.executionCtx.waitUntil(recordReferralClick(c.env, code));
	return c.json({ ok: true }, 200);
});

app.post('/users/referral/convert', async (c) => {
	const body = await c.req
		.json<{ code?: string; user_id?: string }>()
		.catch(() => ({}) as { code?: string; user_id?: string });
	const code = body.code?.trim();
	const userId = body.user_id?.trim();

	// always 200 so a bad code never breaks the caller's signup flow
	if (!code || !userId || !/^\d+$/.test(userId)) {
		return c.json({ ok: false, reason: 'invalid_code' }, 200);
	}

	try {
		const result = await recordConversion(c.env, code, userId, c.executionCtx);
		return c.json(result, 200);
	} catch (err) {
		console.error(`Error recording referral conversion for user '${userId}':`, err);
		return c.json({ ok: false }, 200);
	}
});

/// Quest Challenges

app.post('/users/challenge', async (c) => {
	const body = await c.req
		.json<{
			quest_id?: string;
			quest_title?: string;
			challenger_id?: string;
			challenger_name?: string;
			recipient_id?: string;
			recipient_name?: string;
		}>()
		.catch(() => null);
	if (!body || !body.quest_id || !body.challenger_id || !body.recipient_id) {
		return c.text('quest_id, challenger_id and recipient_id are required', 400);
	}

	try {
		const challenge = await createChallenge(c.env, {
			quest_id: body.quest_id,
			quest_title: body.quest_title || 'a quest',
			challenger_id: body.challenger_id,
			challenger_name: body.challenger_name || 'A friend',
			recipient_id: body.recipient_id,
			recipient_name: body.recipient_name || 'A friend'
		});
		return c.json(challenge, 201);
	} catch (err) {
		console.error('Error creating challenge:', err);
		return c.text('Failed to create challenge', 500);
	}
});

// literal routes must precede the /:id matcher
app.get('/users/challenge/active', async (c) => {
	const userId = c.req.query('user_id');
	const questId = c.req.query('quest_id');
	if (!userId || !questId) return c.text('user_id and quest_id are required', 400);
	const challenge = await getActiveChallengeFor(c.env, userId, questId);
	return c.json(challenge, 200);
});

// the challenge to show in the quest modal (active or pending) for this user+quest
app.get('/users/challenge/for', async (c) => {
	const userId = c.req.query('user_id');
	const questId = c.req.query('quest_id');
	if (!userId || !questId) return c.text('user_id and quest_id are required', 400);
	const challenge = await getChallengeFor(c.env, userId, questId);
	return c.json(challenge, 200);
});

app.get('/users/challenge/list', async (c) => {
	const userId = c.req.query('user_id');
	if (!userId) return c.text('user_id is required', 400);
	return c.json(await listChallengesForUser(c.env, userId), 200);
});

app.post('/users/challenge/:id/accept', async (c) => {
	const body = await c.req.json<{ user_id?: string }>().catch(() => ({}) as { user_id?: string });
	if (!body.user_id) return c.text('user_id is required', 400);
	const result = await acceptChallenge(c.env, c.req.param('id'), body.user_id, c.executionCtx);
	return c.json(result, result.ok ? 200 : result.reason === 'not_found' ? 404 : 409);
});

app.post('/users/challenge/:id/decline', async (c) => {
	const body = await c.req.json<{ user_id?: string }>().catch(() => ({}) as { user_id?: string });
	if (!body.user_id) return c.text('user_id is required', 400);
	const result = await declineChallenge(c.env, c.req.param('id'), body.user_id, c.executionCtx);
	return c.json(result, result.ok ? 200 : result.reason === 'not_found' ? 404 : 409);
});

app.get('/users/challenge/:id', async (c) => {
	const challenge = await getChallenge(c.env, c.req.param('id'));
	if (!challenge) return c.text('Challenge not found', 404);
	return c.json(challenge, 200);
});

/// User Impact Points

app.get('/users/impact_points/leaderboard', async (c) => {
	const limit = c.req.query('limit');
	let limit0 = limit ? parseInt(limit, 10) : TOP_POINTS_LEADERBOARD_COUNT;
	if (isNaN(limit0) || limit0 <= 0) {
		limit0 = TOP_POINTS_LEADERBOARD_COUNT;
	} else if (limit0 > TOP_POINTS_LEADERBOARD_COUNT) {
		limit0 = TOP_POINTS_LEADERBOARD_COUNT;
	}

	try {
		const leaderboard = await retrievePointsLeaderboard(limit0, c.env.KV, c.env.CACHE);
		return c.json(leaderboard, 200);
	} catch (err) {
		console.error('Error retrieving impact points leaderboard:', err);
		return c.text('Failed to retrieve leaderboard', 500);
	}
});

app.get('/users/impact_points/:id/rank', async (c) => {
	const id = c.req.param('id')?.toLowerCase();
	if (!id) {
		return c.text('User ID is required', 400);
	}

	if (!/^\d+$/.test(id)) {
		return c.text('User ID must be numeric', 400);
	}

	if (id.length < 3 || id.length > 50) {
		return c.text('User ID must be between 3 and 50 characters', 400);
	}

	try {
		const rank = await retrievePointsLeaderboardRank(id, c.env.KV, c.env.CACHE);
		return c.json({ rank }, 200);
	} catch (err) {
		console.error(`Error retrieving impact points rank for user '${id}':`, err);
		return c.text('Failed to retrieve leaderboard rank', 500);
	}
});

app.get('/users/impact_points/:id', async (c) => {
	const id = c.req.param('id')?.toLowerCase();
	if (!id) {
		return c.text('User ID is required', 400);
	}

	if (id.length < 3 || id.length > 50) {
		return c.text('User ID must be between 3 and 50 characters', 400);
	}

	try {
		const [points, history] = await getImpactPoints(id, c.env.KV);
		return c.json({ points, history }, 200);
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

	if (!/^\d+$/.test(id)) {
		return c.text('User ID must be numeric', 400);
	}

	const body = await c.req.json<{ points: number; reason?: string }>();
	if (!body.points || body.points <= 0) {
		return c.text('Points must be a positive number', 400);
	}

	if (body.reason && body.reason.length > 200) {
		return c.text('Reason cannot exceed 200 characters', 400);
	}

	try {
		const [newPoints, newHistory] = await addImpactPoints(
			id,
			body.points,
			body.reason || 'Unknown',
			c.env.KV
		);

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

		return c.json({ points: newPoints, history: newHistory }, 200);
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

	if (!/^\d+$/.test(id)) {
		return c.text('User ID must be numeric', 400);
	}

	const body = await c.req.json<{ points: number; reason?: string }>();
	if (!body.points || body.points <= 0) {
		return c.text('Points must be a positive number', 400);
	}

	if (body.reason && body.reason.length > 200) {
		return c.text('Reason cannot exceed 200 characters', 400);
	}

	try {
		const [newPoints, newHistory] = await removeImpactPoints(
			id,
			body.points,
			body.reason || 'Unknown',
			c.env.KV
		);
		return c.json({ points: newPoints, history: newHistory }, 200);
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

	if (!/^\d+$/.test(id)) {
		return c.text('User ID must be numeric', 400);
	}

	const body = await c.req.json<{ points: number; reason?: string }>();
	if (typeof body.points !== 'number' || body.points < 0) {
		return c.text('Points must be a non-negative number', 400);
	}

	if (body.reason && body.reason.length > 200) {
		return c.text('Reason cannot exceed 200 characters', 400);
	}

	try {
		const [newPoints, newHistory] = await setImpactPoints(
			id,
			body.points,
			body.reason || 'Unknown',
			c.env.KV
		);

		return c.json({ points: newPoints, history: newHistory }, 200);
	} catch (err) {
		console.error(`Error setting impact points for user '${id}':`, err);
		return c.text('Failed to set impact points', 500);
	}
});

// User Quests

app.get('/users/quests', async (c) => {
	const quests = await getAllQuests(c.env.KV);
	return c.json(quests, 200);
});

app.get('/users/quests/:id', async (c) => {
	const id = c.req.param('id')?.toLowerCase();
	if (!id) {
		return c.text('Quest ID is required', 400);
	}

	if (id.length < 3 || id.length > 80) {
		return c.text('Quest ID must be between 3 and 80 characters', 400);
	}

	if (!/^[a-z0-9_-]+$/.test(id)) {
		return c.text('Quest ID must be alphanumeric with optional dashes or underscores', 400);
	}

	// per-user quests (mastery, activity) need the requester id to resolve; optional for
	// catalog/custom quests which are user-agnostic
	const userId = c.req.query('user_id')?.toLowerCase();
	if (userId !== undefined) {
		if (userId.length < 3 || userId.length > 50) {
			return c.text('User ID must be between 3 and 50 characters', 400);
		}
		if (!/^\d+$/.test(userId)) {
			return c.text('User ID must be numeric', 400);
		}
	}

	try {
		const quest = await getQuest(id, c.env, userId);
		if (!quest) {
			return c.text('Quest not found', 404);
		}

		return c.json(quest, 200);
	} catch (err) {
		console.error(`Error getting quest '${id}':`, err);
		return c.text('Failed to get quest', 500);
	}
});

function normalizeQuestRank(rank?: string): string | null {
	if (typeof rank !== 'string') {
		return null;
	}

	const normalized = rank.trim().toLowerCase();
	return normalized.length > 0 ? normalized : null;
}

// start new quest (will override existing progress)
app.post('/users/quests/progress/:user_id/start', async (c) => {
	const userId = c.req.param('user_id')?.toLowerCase();
	if (!userId) {
		return c.text('User ID is required', 400);
	}

	if (userId.length < 3 || userId.length > 50) {
		return c.text('User ID must be between 3 and 50 characters', 400);
	}

	if (!/^\d+$/.test(userId)) {
		return c.text('User ID must be numeric', 400);
	}

	let body: { quest_id: string; rank?: string };
	try {
		body = await c.req.json<{ quest_id: string; rank?: string }>();
	} catch (err) {
		return c.text('Request body must be valid JSON', 400);
	}

	if (!body.quest_id) {
		return c.text('Quest ID is required', 400);
	}

	const questId = body.quest_id.toLowerCase();
	const quest = await getQuest(questId, c.env, userId);
	if (!quest) {
		return c.text('Quest not found', 404);
	}

	const rank = normalizeQuestRank(body.rank);
	if (quest.premium) {
		if (!rank) {
			return c.text('Rank is required for premium quests', 400);
		}

		if (rank === 'free') {
			return c.text('Premium quests require a non-free rank', 403);
		}
	}

	// block restarts of permanently-locked mastery quests
	const startingMasteryBadgeId = questId.startsWith('badge_mastery_')
		? questId.replace('badge_mastery_', '')
		: null;
	if (startingMasteryBadgeId) {
		const locked = await isMasteryLocked(userId, startingMasteryBadgeId, c.env.KV);
		if (locked) {
			return c.text('Mastery for this badge has been permanently locked', 410);
		}
	}

	const activeProgress = await getCurrentQuestProgress(userId, c.env, c.executionCtx);
	if (activeProgress.questId && !activeProgress.completed && activeProgress.questId !== questId) {
		const lockResult = await lockActiveMasteryIfApplicable(
			userId,
			activeProgress.questId,
			c.env.KV
		);
		if (lockResult.locked) {
			console.log(
				`User ${userId} abandoned mastery quest for badge '${lockResult.badgeId}' by starting '${questId}'`
			);
		}
	}

	try {
		await startQuest(userId, questId, c.env);
		return c.text('Quest started', 201);
	} catch (err) {
		console.error(`Error starting quest '${questId}' for user '${userId}':`, err);
		return c.text('Failed to start quest', 500);
	}
});

// update quest progress
app.patch('/users/quests/progress/:user_id/update', async (c) => {
	// stopwatch phases — used to emit Server-Timing for slow/flaky submits
	const requestStart = performance.now();
	const phases: Array<[string, number]> = [];
	let phaseStart = requestStart;
	const markPhase = (label: string) => {
		const now = performance.now();
		phases.push([label, now - phaseStart]);
		phaseStart = now;
	};

	const writeServerTiming = () => {
		const entries = phases
			.map(([label, dur]) => `${label};dur=${dur.toFixed(1)}`)
			.concat([`total;dur=${(performance.now() - requestStart).toFixed(1)}`]);
		c.header('Server-Timing', entries.join(', '));
	};

	const userId = c.req.param('user_id')?.toLowerCase();
	if (!userId) {
		writeServerTiming();
		return c.json({ message: 'User ID is required', code: 400 }, 400);
	}

	if (userId.length < 3 || userId.length > 50) {
		writeServerTiming();
		return c.json({ message: 'User ID must be between 3 and 50 characters', code: 400 }, 400);
	}

	if (!/^\d+$/.test(userId)) {
		writeServerTiming();
		return c.json({ message: 'User ID must be numeric', code: 400 }, 400);
	}

	let body: {
		device: QuestDeviceMetadata;
		rank?: string;
		response: {
			type: string;
			index: number;
			altIndex?: number;
			dataUrl?: string;
			eventId?: string;
			timestamp?: number;
			scoreKey?: string;
			score?: number;
			text?: string;
			distance?: number;
			data?: string;
			format?: number;
		};
	};

	try {
		body = await c.req.json<typeof body>();
	} catch (jsonErr) {
		writeServerTiming();
		return c.json({ message: 'Request body must be valid JSON', code: 400 }, 400);
	}

	if (!body.device) {
		writeServerTiming();
		return c.json({ message: 'Device metadata is required', code: 400 }, 400);
	}

	if (!body.response) {
		writeServerTiming();
		return c.json({ message: 'Step response is required', code: 400 }, 400);
	}

	markPhase('parse');

	const binaryTypes = [
		'take_photo_location',
		'take_photo_classification',
		'take_photo_caption',
		'take_photo_objects',
		'take_photo_validation',
		'take_photo_list',
		'draw_picture',
		'transcribe_audio'
	];
	const isBinaryType = binaryTypes.includes(body.response.type);

	let response: QuestStepResponse;

	if (isBinaryType) {
		if (!body.response.dataUrl) {
			writeServerTiming();
			return c.json(
				{ message: 'A base64 data URL is required for this step type', code: 400 },
				400
			);
		}

		const parsed = fromDataURL(body.response.dataUrl);
		if (!parsed) {
			writeServerTiming();
			return c.json(
				{ message: 'Invalid data URL format. Expected: data:<mime>;base64,<data>', code: 400 },
				400
			);
		}

		const isAudio = body.response.type === 'transcribe_audio';
		const maxBytes = isAudio ? 5 * 1024 * 1024 : 25 * 1024 * 1024;

		if (parsed.data.length > maxBytes) {
			writeServerTiming();
			return c.json(
				{
					message: `${isAudio ? 'Audio' : 'Image'} data exceeds the ${isAudio ? '5 MB' : '25 MB'} size limit`,
					code: 400
				},
				400
			);
		}

		if (isAudio) {
			const fmt = detectAudioFormat(parsed.data);
			if (!fmt) {
				writeServerTiming();
				return c.json(
					{
						message: 'Unsupported audio format. Only MP3, FLAC, AAC, and M4A are accepted.',
						code: 415
					},
					415
				);
			}
		}

		response = {
			type: body.response.type,
			index: body.response.index,
			altIndex: body.response.altIndex,
			data: parsed.data
		} as QuestStepResponse;
		markPhase('decode-upload');
	} else {
		if (body.response.type === 'describe_text' && typeof body.response.text !== 'string') {
			writeServerTiming();
			return c.json({ message: 'Text is required for describe_text steps', code: 400 }, 400);
		}

		if (body.response.type === 'distance_covered') {
			if (
				typeof body.response.distance !== 'number' ||
				!Number.isFinite(body.response.distance) ||
				body.response.distance < 0
			) {
				writeServerTiming();
				return c.json(
					{
						message:
							'A non-negative numeric distance (meters) is required for distance_covered steps',
						code: 400
					},
					400
				);
			}
		}

		if (body.response.type === 'scan_barcode') {
			if (typeof body.response.data !== 'string' || body.response.data.trim().length === 0) {
				writeServerTiming();
				return c.json(
					{ message: 'A non-empty scan value is required for scan_barcode steps', code: 400 },
					400
				);
			}
			if (
				typeof body.response.format !== 'number' ||
				!Number.isFinite(body.response.format) ||
				body.response.format < 0
			) {
				writeServerTiming();
				return c.json(
					{
						message: 'A numeric Capacitor barcode format is required for scan_barcode steps',
						code: 400
					},
					400
				);
			}
		}

		response = {
			type: body.response.type,
			index: body.response.index,
			altIndex: body.response.altIndex,
			...(body.response.eventId !== undefined && { eventId: body.response.eventId }),
			...(body.response.timestamp !== undefined && { timestamp: body.response.timestamp }),
			...(body.response.scoreKey !== undefined && { scoreKey: body.response.scoreKey }),
			...(body.response.score !== undefined && { score: body.response.score }),
			...(body.response.text !== undefined && { text: body.response.text }),
			...(body.response.distance !== undefined && { distance: body.response.distance }),
			...(body.response.data !== undefined && { data: body.response.data }),
			...(body.response.format !== undefined && { format: body.response.format })
		} as QuestStepResponse;
	}

	const activeQuestProgress = await getCurrentQuestProgress(userId, c.env, c.executionCtx);
	const activeQuest = activeQuestProgress.quest;
	markPhase('load-quest');
	if (!activeQuest) {
		writeServerTiming();
		return c.json({ message: 'No active quest found', code: 404 }, 404);
	}

	const rank = normalizeQuestRank(body.rank);
	if (activeQuest.premium) {
		if (!rank) {
			writeServerTiming();
			return c.json({ message: 'Rank is required for premium quests', code: 400 }, 400);
		}

		if (rank === 'free') {
			await resetQuestProgress(userId, c.env);
			writeServerTiming();
			return c.json(
				{
					message: 'Premium quests cannot be updated with free rank; progress has been reset',
					code: 403
				},
				403
			);
		}
	}

	const delayCheck = await checkStepDelay(
		userId,
		body.response.index,
		body.response.altIndex,
		c.env,
		rank
	);
	if (!delayCheck.available) {
		const s = delayCheck.secondsRemaining!;
		writeServerTiming();
		return c.json(
			{
				message: `Step not yet available. Try again in ${s} second${s === 1 ? '' : 's'}.`,
				code: 425,
				availableAt: delayCheck.availableAt
			},
			425
		);
	}
	markPhase('delay-check');

	try {
		const result = await updateQuestProgress(
			userId,
			response,
			body.device,
			c.env,
			c.executionCtx,
			rank,
			markPhase
		);
		writeServerTiming();
		return c.json(result, 200);
	} catch (error) {
		writeServerTiming();
		if (error instanceof HTTPException) {
			return c.json({ message: error.message, code: error.status }, error.status);
		}

		console.error(`Error updating quest progress:`, error);
		return c.json({ message: 'Failed to update quest progress', code: 500 }, 500);
	}
});

app.delete('/users/quests/progress/:user_id/reset', async (c) => {
	const userId = c.req.param('user_id')?.toLowerCase();
	if (!userId) {
		return c.text('User ID is required', 400);
	}

	if (userId.length < 3 || userId.length > 50) {
		return c.text('User ID must be between 3 and 50 characters', 400);
	}

	if (!/^\d+$/.test(userId)) {
		return c.text('User ID must be numeric', 400);
	}

	try {
		// If the active quest is a mastery quest, resetting permanently locks it.
		const activeProgress = await getCurrentQuestProgress(userId, c.env, c.executionCtx);
		if (activeProgress.questId && !activeProgress.completed) {
			const lockResult = await lockActiveMasteryIfApplicable(
				userId,
				activeProgress.questId,
				c.env.KV
			);
			if (lockResult.locked) {
				console.log(
					`User ${userId} reset mastery quest for badge '${lockResult.badgeId}'; locking permanently.`
				);
			}
		}

		await resetQuestProgress(userId, c.env);
		return c.body(null, 204);
	} catch (err) {
		console.error(`Error resetting quest progress for user '${userId}':`, err);
		return c.text('Failed to reset quest progress', 500);
	}
});

app.get('/users/quests/progress/:user_id', async (c) => {
	const userId = c.req.param('user_id')?.toLowerCase();
	if (!userId) {
		return c.text('User ID is required', 400);
	}

	if (userId.length < 3 || userId.length > 50) {
		return c.text('User ID must be between 3 and 50 characters', 400);
	}

	if (!/^\d+$/.test(userId)) {
		return c.text('User ID must be numeric', 400);
	}

	try {
		const progress = await getCurrentQuestProgress(userId, c.env, c.executionCtx);

		if (progress.completed) {
			await maybeArchiveCompletedQuest(userId, c.env, c.executionCtx);

			// after archiving the active key is deleted; return the snapshot we already read.
			const enrichedProgress = await enrichProgressEntries(progress.progress, c.env);
			return c.json({ ...progress, progress: enrichedProgress }, 200);
		}

		const enrichedProgress = await enrichProgressEntries(progress.progress, c.env);
		return c.json({ ...progress, progress: enrichedProgress }, 200);
	} catch (err) {
		console.error(`Error getting quest progress for user '${userId}':`, err);
		return c.text('Failed to get quest progress', 500);
	}
});

// get progress for a specific step index
app.get('/users/quests/progress/:user_id/step/:step_index', async (c) => {
	const userId = c.req.param('user_id')?.toLowerCase();
	const stepIndexParam = c.req.param('step_index');
	if (!userId || !stepIndexParam) {
		return c.text('User ID and step index are required', 400);
	}

	if (userId.length < 3 || userId.length > 50) {
		return c.text('User ID must be between 3 and 50 characters', 400);
	}

	if (!/^\d+$/.test(userId)) {
		return c.text('User ID must be numeric', 400);
	}

	const stepIndex = parseInt(stepIndexParam, 10);
	if (isNaN(stepIndex) || stepIndex < 0) {
		return c.text('Step index must be a non-negative integer', 400);
	}

	try {
		const { progress, quest, currentStepIndex, completed } = await getCurrentQuestProgress(
			userId,
			c.env,
			c.executionCtx
		);
		if (!quest) {
			return c.text('No active quest found for user', 404);
		}

		if (stepIndex >= quest.steps.length) {
			return c.text('Step index out of range', 404);
		}

		// only return progress for steps the user has reached
		if (stepIndex > currentStepIndex && !completed) {
			return c.text('Step not yet reached', 403);
		}

		const stepDef = quest.steps[stepIndex];
		const stepProgress = progress[stepIndex] ?? null;

		// enrich with data URLs for binary payloads (photos, drawings, audio)
		const enrichedStepProgress =
			stepProgress !== null ? (await enrichProgressEntries([stepProgress], c.env))[0] : null;
		const isCurrent = stepIndex === currentStepIndex;

		return c.json(
			{
				stepIndex,
				stepDef,
				// for alt steps: array of completed alt responses; for normal steps: single response or null
				response: enrichedStepProgress,
				isAltStep: Array.isArray(stepDef),
				isCurrent,
				completed: stepProgress !== null && stepProgress !== undefined
			},
			200
		);
	} catch (err) {
		console.error(`Error getting step progress for user '${userId}':`, err);
		return c.text('Failed to get step progress', 500);
	}
});

// get list of completed quests for a user
app.get('/users/quests/history/:user_id', async (c) => {
	const userId = c.req.param('user_id')?.toLowerCase();
	if (!userId) {
		return c.text('User ID is required', 400);
	}

	if (userId.length < 3 || userId.length > 50) {
		return c.text('User ID must be between 3 and 50 characters', 400);
	}

	if (!/^\d+$/.test(userId)) {
		return c.text('User ID must be numeric', 400);
	}

	const page = Math.max(1, parseInt(c.req.query('page') ?? '1', 10) || 1);
	const limitRaw = parseInt(c.req.query('limit') ?? '25', 10) || 25;
	const limit = Math.min(100, Math.max(1, limitRaw));
	const search = (c.req.query('search') ?? '').trim().toLowerCase();
	const sort = (c.req.query('sort') ?? 'desc').toLowerCase() as 'asc' | 'desc' | 'rand';

	try {
		const userId0 = normalizeId(userId);
		const questIds = await getQuestHistory(userId, c.env);
		// resolve quest metadata + completedAt in parallel; no r2 reads, no enrichment in list
		const resolved = await Promise.all(
			questIds.map(async (questId) => {
				const [meta, quest] = await Promise.all([
					c.env.KV.get<{ r2Key: string; completedAt: number }>(
						`user:quest_history:${userId0}:${questId}`,
						'json'
					),
					getQuest(questId, c.env, userId)
				]);
				if (!quest) return null;
				return {
					questId,
					quest,
					completedAt: meta?.completedAt ?? null
				};
			})
		);

		const items = resolved.filter((x): x is NonNullable<typeof x> => x !== null);

		const filtered = search
			? items.filter(
					(i) =>
						i.quest.title.toLowerCase().includes(search) ||
						i.quest.id.toLowerCase().includes(search)
				)
			: items;

		// newest first; null completedAt sorts to the end
		filtered.sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));

		const total = filtered.length;
		const start = (page - 1) * limit;
		const paginated = filtered.slice(start, start + limit).sort((a, b) => {
			if (sort === 'asc') {
				return (a.completedAt ?? 0) - (b.completedAt ?? 0);
			}
			if (sort === 'rand') {
				return Math.random() - 0.5;
			}
			return (b.completedAt ?? 0) - (a.completedAt ?? 0);
		});

		return c.json({ items: paginated, total, page, limit, sort }, 200);
	} catch (err) {
		console.error(`Error getting quest history for user '${userId}':`, err);
		return c.text('Failed to get quest history', 500);
	}
});

// get completed progress for a specific quest
app.get('/users/quests/history/:user_id/:quest_id', async (c) => {
	const userId = c.req.param('user_id')?.toLowerCase();
	const questId = c.req.param('quest_id')?.toLowerCase();
	if (!userId || !questId) {
		return c.text('User ID and Quest ID are required', 400);
	}

	if (userId.length < 3 || userId.length > 50) {
		return c.text('User ID must be between 3 and 50 characters', 400);
	}

	if (!/^\d+$/.test(userId)) {
		return c.text('User ID must be numeric', 400);
	}

	if (questId.length < 3 || questId.length > 80) {
		return c.text('Quest ID must be between 3 and 80 characters', 400);
	}

	if (!/^[a-z0-9_-]+$/.test(questId)) {
		return c.text('Quest ID must be alphanumeric with optional dashes or underscores', 400);
	}

	// require user_id to resolve
	const quest = await getQuest(questId, c.env, userId);
	if (!quest) {
		return c.text('Quest not found', 404);
	}

	try {
		const result = await getCompletedQuestProgress(userId, questId, c.env, c.executionCtx);
		if (!result) {
			return c.text('Completed quest not found', 404);
		}
		const enrichedProgress = await enrichProgressEntries(result.progress, c.env);
		return c.json({ ...result, quest: result.quest ?? quest, progress: enrichedProgress }, 200);
	} catch (err) {
		console.error(`Error getting completed quest '${questId}' for user '${userId}':`, err);
		return c.text('Failed to get completed quest progress', 500);
	}
});

/// Custom Quests

app.post('/users/quests/custom', async (c) => {
	const userId = c.req.query('user_id')?.toLowerCase();
	if (!userId) {
		return c.text('User ID is required', 400);
	}

	if (userId.length < 3 || userId.length > 50) {
		return c.text('User ID must be between 3 and 50 characters', 400);
	}

	if (!/^\d+$/.test(userId)) {
		return c.text('User ID must be numeric', 400);
	}

	const { title, description, icon, steps, permissions, reward } =
		await c.req.json<CustomQuestCreateInput>();

	if (!title || title.trim().length === 0) {
		return c.text('Title is required', 400);
	}

	if (!description || description.trim().length === 0) {
		return c.text('Description is required', 400);
	}

	if (!steps || !Array.isArray(steps) || steps.length === 0) {
		return c.text('At least one step is required', 400);
	}

	if (!reward || typeof reward !== 'number' || reward <= 0) {
		return c.text('Reward must be a positive number', 400);
	}

	try {
		const customQuest = await createCustomQuest(
			{
				owner_id: userId,
				title: title.trim(),
				description: description.trim(),
				icon: icon?.trim() || 'mdi:earth',
				steps,
				permissions: permissions || [],
				reward
			},
			c.env.KV
		);

		return c.json(customQuest, 201);
	} catch (err) {
		console.error(`Error creating custom quest for user '${userId}':`, err);
		return c.text('Failed to create custom quest', 500);
	}
});

app.patch('/users/quests/custom/:quest_id', async (c) => {
	const userId = c.req.query('user_id')?.toLowerCase();
	if (!userId) {
		return c.text('User ID is required', 400);
	}

	if (userId.length < 3 || userId.length > 50) {
		return c.text('User ID must be between 3 and 50 characters', 400);
	}

	if (!/^\d+$/.test(userId)) {
		return c.text('User ID must be numeric', 400);
	}

	const questId = c.req.param('quest_id')?.toLowerCase();
	if (!questId) {
		return c.text('Quest ID is required', 400);
	}

	if (questId.length < 3 || questId.length > 80) {
		return c.text('Quest ID must be between 3 and 80 characters', 400);
	}

	const body = await c.req.json<CustomQuestUpdateInput>();
	if (
		body.title === undefined &&
		body.description === undefined &&
		body.icon === undefined &&
		body.steps === undefined &&
		body.permissions === undefined &&
		body.reward === undefined
	) {
		return c.text('At least one field must be provided', 400);
	}
	if (body.title !== undefined && body.title.trim().length === 0) {
		return c.text('Title cannot be empty', 400);
	}

	if (body.description !== undefined && body.description.trim().length === 0) {
		return c.text('Description cannot be empty', 400);
	}

	if (body.reward !== undefined && (typeof body.reward !== 'number' || body.reward <= 0)) {
		return c.text('Reward must be a positive number', 400);
	}

	try {
		const quest = await getCustomQuest(questId, c.env.KV);
		if (!quest) {
			return c.text('Custom quest not found', 404);
		}

		if (quest.owner_id !== userId) {
			return c.text('You do not have permission to edit this custom quest', 403);
		}

		const updatedQuest = await updateCustomQuest(questId, body, c.env.KV);
		if (!updatedQuest) {
			return c.text('Custom quest not found', 404);
		}
		return c.json(updatedQuest, 200);
	} catch (err) {
		console.error(`Error updating custom quest '${questId}' for user '${userId}':`, err);
		return c.text('Failed to update custom quest', 500);
	}
});

app.delete('/users/quests/custom/:quest_id', async (c) => {
	const userId = c.req.query('user_id')?.toLowerCase();
	if (!userId) {
		return c.text('User ID is required', 400);
	}

	if (userId.length < 3 || userId.length > 50) {
		return c.text('User ID must be between 3 and 50 characters', 400);
	}

	if (!/^\d+$/.test(userId)) {
		return c.text('User ID must be numeric', 400);
	}

	const questId = c.req.param('quest_id')?.toLowerCase();
	if (!questId) {
		return c.text('Quest ID is required', 400);
	}

	if (questId.length < 3 || questId.length > 80) {
		return c.text('Quest ID must be between 3 and 80 characters', 400);
	}

	try {
		const quest = await getCustomQuest(questId, c.env.KV);
		if (!quest) {
			return c.text('Custom quest not found', 404);
		}

		if (quest.owner_id !== userId) {
			return c.text('You do not have permission to delete this custom quest', 403);
		}

		await deleteCustomQuest(questId, c.env.KV);
		return c.body(null, 204);
	} catch (err) {
		console.error(`Error deleting custom quest '${questId}' for user '${userId}':`, err);
		return c.text('Failed to delete custom quest', 500);
	}
});

// Events

function parsePositiveEventId(idParam: string | undefined): bigint | null {
	if (!idParam || !/^\d+$/.test(idParam)) {
		return null;
	}

	try {
		const id = BigInt(idParam);
		return id > 0n ? id : null;
	} catch {
		return null;
	}
}

function sanitizeHeaderValue(value: string | null | undefined): string {
	if (!value) {
		return 'Unknown';
	}

	const sanitized = value.replace(/[\r\n]+/g, ' ').trim();
	return sanitized.length > 0 ? sanitized : 'Unknown';
}

function toBodyBytes(image: Uint8Array): Uint8Array<ArrayBuffer> {
	const copy = new Uint8Array(image.length);
	copy.set(image);
	return copy;
}

function buildEventThumbnailHeaders(
	id: bigint,
	imageSize: number,
	author: string | null | undefined
): Record<string, string> {
	return {
		'X-Event-Thumbnail-Author': sanitizeHeaderValue(author),
		'Content-Type': 'image/webp',
		'Content-Length': imageSize.toString(),
		'Content-Disposition': `inline; filename="event_${id}_thumbnail.webp"`,
		'Cache-Control': 'public, max-age=31536000, immutable'
	};
}

app.get('/events/thumbnail/:id', async (c) => {
	const id = parsePositiveEventId(c.req.param('id'));
	if (id === null) {
		return c.text('Invalid Event ID', 400);
	}

	try {
		const [image, author] = await getEventThumbnail(id, c.env);
		if (!image || image.length === 0) {
			return c.text('Event thumbnail not found', 404);
		}

		return c.body(toBodyBytes(image), 200, buildEventThumbnailHeaders(id, image.length, author));
	} catch (err) {
		console.error('Error retrieving event thumbnail', { eventId: id.toString(), err });
		return c.text('Failed to get event thumbnail', 500);
	}
});

app.get('/events/thumbnail/:id/metadata', async (c) => {
	const id = parsePositiveEventId(c.req.param('id'));
	if (id === null) {
		return c.text('Invalid Event ID', 400);
	}

	try {
		const [image, author] = await getEventThumbnail(id, c.env);
		if (!image || image.length === 0) {
			return c.text('Event thumbnail not found', 404);
		}

		return c.json(
			{
				author: sanitizeHeaderValue(author),
				size: image.length
			},
			200
		);
	} catch (err) {
		console.error('Error retrieving event thumbnail metadata', {
			eventId: id.toString(),
			err
		});
		return c.text('Failed to get event thumbnail metadata', 500);
	}
});

app.post('/events/thumbnail/:id', async (c) => {
	const id = parsePositiveEventId(c.req.param('id'));
	if (id === null) {
		return c.text('Invalid Event ID', 400);
	}

	const contentType = c.req.header('Content-Type') || '';

	// content will be converted to webp, but must be an image type
	if (!contentType.startsWith('image/')) {
		return c.text('Content-Type must be an image type', 400);
	}

	let body: ArrayBuffer;
	try {
		body = await c.req.arrayBuffer();
	} catch (err) {
		console.error('Failed to read uploaded event thumbnail body', {
			eventId: id.toString(),
			err
		});
		return c.text('Failed to read image payload', 400);
	}

	const imageData = new Uint8Array(body);
	if (imageData.length === 0) {
		return c.text('Image data is required', 400);
	}

	try {
		await uploadEventThumbnail(id, imageData, '<user>', c.env, c.executionCtx);
		return c.body(null, 204);
	} catch (err) {
		console.error('Failed to upload event thumbnail', {
			eventId: id.toString(),
			err
		});
		return c.text('Failed to upload event thumbnail', 500);
	}
});

app.post('/events/thumbnail/:id/generate', async (c) => {
	const id = parsePositiveEventId(c.req.param('id'));
	if (id === null) {
		return c.text('Invalid Event ID', 400);
	}

	const name = c.req.query('name')?.trim();
	if (!name || name.length < 3) {
		return c.text('Event name is required to generate thumbnail', 400);
	}

	const source = c.req.query('source')?.trim();
	if (source && !prompts.isPlaceBirthdaySource(source)) {
		return c.text('Only place-based birthday source entries can generate place thumbnails', 400);
	}

	const location = extractLocationFromEventName(name);
	if (!location) {
		return c.text(
			'Only place-based birthday events are allowed for automatic thumbnail generation',
			400
		);
	}

	try {
		const [image, author] = await uploadPlaceThumbnail(location, id, c.env, c.executionCtx);
		if (!image || image.length === 0) {
			return c.text('No thumbnail found for specified location', 404);
		}

		return c.body(toBodyBytes(image), 200, buildEventThumbnailHeaders(id, image.length, author));
	} catch (err) {
		console.error('Error generating event thumbnail', {
			eventId: id.toString(),
			name,
			location,
			err
		});
		return c.text('Failed to generate event thumbnail', 500);
	}
});

app.delete('/events/thumbnail/:id', async (c) => {
	const id = parsePositiveEventId(c.req.param('id'));
	if (id === null) {
		return c.text('Invalid Event ID', 400);
	}

	try {
		await deleteEventThumbnail(id, c.env, c.executionCtx);
		return c.body(null, 204);
	} catch (err) {
		console.error('Failed to delete event thumbnail', { eventId: id.toString(), err });
		return c.text('Failed to delete event thumbnail', 500);
	}
});

app.post('/users/recommend_events', async (c) => {
	const body = await c.req.json<{
		pool: Event[];
		activities: string[];
		limit?: number;
	}>();

	if (!body || !Array.isArray(body.pool) || !Array.isArray(body.activities)) {
		return c.text('Invalid request body', 400);
	}

	body.pool = body.pool.filter((e) => e && e.id && e.name).slice(0, 20);
	body.activities = body.activities
		.filter((a) => typeof a === 'string' && a.trim().length > 0)
		.slice(0, 10);

	if (body.pool.length === 0 || body.activities.length === 0) {
		return c.json([], 200);
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

	if (!body || !body.event || !Array.isArray(body.pool)) {
		return c.text('Invalid request body', 400);
	}

	body.pool = body.pool.filter((e) => e && e.id && e.name).slice(0, 20);

	if (body.pool.length === 0) {
		return c.json([], 200);
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

	if (!body.photo_url.startsWith('data:image/') || !body.photo_url.includes(';base64,')) {
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
	// images are downscaled before ai scoring, so this only guards the upload (keep it generous
	// for straight-from-camera phone photos)
	const MAX_IMAGE_SIZE = 25 * 1024 * 1024; // 25MB
	if (len === 0) {
		return c.text('Image data is required', 400);
	}
	if (len > MAX_IMAGE_SIZE) {
		return c.text('Image size exceeds 25MB limit', 413);
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

	// limit to 3 per user
	const indexKey = `event:${id}:user:${userId}:submission_ids`;
	const userEventSubmissions = (await c.env.KV.get<string[]>(indexKey, 'json')) ?? [];
	if (userEventSubmissions.length >= 3) {
		return c.text('Submission limit reached for this event', 400);
	}

	const res = await submitEventImage(id, userId, imageData, c.env, c.executionCtx);

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
				metadata: { caption, scored_at: Date.now(), user_id: userId.toString() }
			});

			console.log(`Scored image submission ${res.id} for event ${id} with score:`, score);

			await addBadgeProgress(userIdParam, 'event_images_submitted', '1', c.env.KV);

			if (score.score >= 90) {
				await addBadgeProgress(userIdParam, 'event_images_submitted_good', '1', c.env.KV);
			}

			return Promise.allSettled([
				(async () => {
					const quest = await getCurrentQuestProgress(userId.toString(), c.env, c.executionCtx);
					if (!quest) return;

					async function checkStep(
						step: QuestStep,
						score: number,
						index: number,
						altIndex?: number
					) {
						if (step.type !== 'submit_event_image') return;

						const [activity, threshold] = step.parameters;
						if (!body.event.activities.includes(activity)) return;
						if (!score || score < threshold) return;

						await updateQuestProgress(
							userId.toString(),
							{
								type: 'submit_event_image',
								index,
								altIndex,
								eventId: id.toString(),
								score,
								timestamp: Date.now()
							},
							API_DEVICE_METADATA,
							c.env,
							c.executionCtx
						);
					}

					const currentStep = quest.currentStep;
					if (Array.isArray(currentStep)) {
						await Promise.allSettled(
							currentStep.map((altStep, altIndex) =>
								checkStep(altStep, score.score, quest.currentStepIndex, altIndex).catch((err) => {
									console.error(
										'Error updating quest progress in event image submission for alt step:',
										{
											userId: userId.toString(),
											eventId: id.toString(),
											stepIndex: quest.currentStepIndex,
											altIndex,
											err
										}
									);
								})
							)
						);
					} else if (currentStep?.type === 'submit_event_image') {
						await checkStep(currentStep, score.score, quest.currentStepIndex).catch((err) => {
							console.error('Error updating quest progress in event image submission for step:', {
								userId: userId.toString(),
								eventId: id.toString(),
								stepIndex: quest.currentStepIndex,
								err
							});
						});
					}
				})()
			]);
		})()
	);

	return c.json({ submission_id: res.id, success: true }, 201);
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

	// Parse pagination parameters
	const limitParam = c.req.query('limit');
	const pageParam = c.req.query('page');
	const sortParam = c.req.query('sort');
	const searchParam = c.req.query('search');

	let limit = 100; // default
	if (limitParam) {
		const parsedLimit = parseInt(limitParam, 10);
		if (isNaN(parsedLimit) || parsedLimit <= 0) {
			return c.text('Invalid limit parameter', 400);
		}
		if (parsedLimit > 500) {
			return c.text('Limit cannot exceed 500', 400);
		}
		limit = parsedLimit;
	}

	let page = 1; // default
	if (pageParam) {
		const parsedPage = parseInt(pageParam, 10);
		if (isNaN(parsedPage) || parsedPage <= 0) {
			return c.text('Invalid page parameter', 400);
		}
		page = parsedPage;
	}

	let sort: 'asc' | 'desc' | 'rand' = 'desc'; // default
	if (sortParam) {
		if (sortParam !== 'asc' && sortParam !== 'desc' && sortParam !== 'rand') {
			return c.text("Invalid sort parameter (must be 'asc', 'desc', or 'rand')", 400);
		}
		sort = sortParam;
	}

	const search = searchParam?.trim() || undefined;

	// Fetch submissions with image data and scores
	const submissions = await getEventImageSubmissionsWithData(
		eventId,
		userId,
		c.env,
		limit,
		page,
		sort,
		search
	);

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
	const eventIdParam = c.req.query('event_id');
	const userIdParam = c.req.query('user_id');

	if (!submissionId && !eventIdParam && !userIdParam) {
		return c.text('At least one of submission_id, event_id, or user_id is required', 400);
	}

	// handle single delete
	if (submissionId) {
		if (submissionId.trim().length === 0) {
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
	}

	// handle multiple delete
	if (eventIdParam || userIdParam) {
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

		await deleteEventImageSubmissions(eventId, userId, c.env, c.executionCtx);
	}

	return c.body(null, 204);
});

// Onboarding

app.get('/users/onboarding/:id', async (c) => {
	const id = c.req.param('id');
	if (!id) return c.text('Missing user id', 400);
	const state = await getOrCreateOnboarding(c.env, id);
	return c.json({ state, steps: ONBOARDING_STEPS }, 200);
});

app.post('/users/onboarding/:id/step', async (c) => {
	const id = c.req.param('id');
	if (!id) return c.text('Missing user id', 400);
	let body: { step?: string } = {};
	try {
		body = await c.req.json();
	} catch {
		return c.text('Invalid JSON', 400);
	}
	const step = body.step as OnboardingStepId;
	if (!step || !ONBOARDING_STEPS.includes(step)) {
		return c.text('Invalid step', 400);
	}
	const state = await completeOnboardingStep(c.env, id, step);
	return c.json({ state }, 200);
});

app.post('/users/onboarding/:id/persona', async (c) => {
	const id = c.req.param('id');
	if (!id) return c.text('Missing user id', 400);
	let body: { persona?: string; interests?: string[] } = {};
	try {
		body = await c.req.json();
	} catch {
		return c.text('Invalid JSON', 400);
	}
	if (typeof body.persona !== 'string' || body.persona.length === 0 || body.persona.length > 64) {
		return c.text('Invalid persona', 400);
	}
	const interests = Array.isArray(body.interests)
		? body.interests.filter((s): s is string => typeof s === 'string' && s.length > 0).slice(0, 20)
		: [];
	const state = await setPersona(c.env, id, body.persona, interests);
	return c.json({ state }, 200);
});

app.post('/users/onboarding/:id/dismiss', async (c) => {
	const id = c.req.param('id');
	if (!id) return c.text('Missing user id', 400);
	const state = await dismissOnboarding(c.env, id);
	return c.json({ state }, 200);
});

app.delete('/users/onboarding/:id', async (c) => {
	const id = c.req.param('id');
	if (!id) return c.text('Missing user id', 400);
	await resetOnboarding(c.env, id);
	return c.body(null, 204);
});

// Admin: blacklists

app.get('/admin/blacklist', async (c) => {
	const kind = c.req.query('kind');
	if (kind && kind !== 'username' && kind !== 'email') {
		return c.text('Invalid kind', 400);
	}
	const entries = await listBlacklist(c.env, kind as BlacklistKind | undefined);
	return c.json({ entries }, 200);
});

app.post('/admin/blacklist', async (c) => {
	let body: { kind?: string; value?: string; reason?: string; added_by?: string } = {};
	try {
		body = await c.req.json();
	} catch {
		return c.text('Invalid JSON', 400);
	}
	if (body.kind !== 'username' && body.kind !== 'email') {
		return c.text('Invalid kind', 400);
	}
	if (!body.value || typeof body.value !== 'string' || body.value.length > 128) {
		return c.text('Invalid value', 400);
	}
	const entry = await addToBlacklist(
		c.env,
		body.kind,
		body.value,
		body.reason ?? '',
		body.added_by
	);
	return c.json({ entry }, 201);
});

app.delete('/admin/blacklist', async (c) => {
	const kind = c.req.query('kind');
	const value = c.req.query('value');
	if (kind !== 'username' && kind !== 'email') {
		return c.text('Invalid kind', 400);
	}
	if (!value) return c.text('Missing value', 400);
	const removed = await removeFromBlacklist(c.env, kind, value);
	return removed ? c.body(null, 204) : c.text('Not found', 404);
});

app.get('/admin/blacklist/check', async (c) => {
	const kind = c.req.query('kind');
	const value = c.req.query('value');
	if (kind !== 'username' && kind !== 'email') {
		return c.text('Invalid kind', 400);
	}
	if (!value) return c.text('Missing value', 400);
	const entry = await isBlacklisted(c.env, kind, value);
	return c.json({ blacklisted: entry !== null, entry }, 200);
});

// admin - analytics

app.get('/admin/analytics', async (c) => {
	const since = c.req.query('since') || undefined;
	const until = c.req.query('until') || undefined;
	const snapshot = await getAnalyticsSnapshot(c.env, since, until);
	return c.json(snapshot, 200);
});

app.post('/admin/funnel/:field', async (c) => {
	const field = c.req.param('field');
	if (
		field !== 'signup_views' &&
		field !== 'signups_completed' &&
		field !== 'verifications_completed'
	) {
		return c.text('Invalid field', 400);
	}
	const next = await bumpSignupFunnel(c.env, field);
	return c.json(next, 200);
});

// MoodSpark - anonymous emoji-vote aggregator. fully anonymous, no user state.

app.get('/mood/:topic/:date', async (c) => {
	const topic = sanitizeTopic(c.req.param('topic'));
	const date = sanitizeDate(c.req.param('date'));
	if (!topic) return c.text('Invalid topic', 400);
	if (!date) return c.text('Invalid date', 400);

	const snapshot = await getMoodSnapshot(c.env, topic, date);
	const payload = snapshot ?? {
		counts: EMOJIS.reduce<Record<string, number>>((acc, e) => {
			acc[e] = 0;
			return acc;
		}, {}),
		total: 0,
		updated_at: 0
	};

	c.header('Cache-Control', 'public, max-age=30');
	return c.json(payload, 200);
});

app.post('/mood/:topic/:date', async (c) => {
	const topic = sanitizeTopic(c.req.param('topic'));
	const date = sanitizeDate(c.req.param('date'));
	if (!topic) return c.text('Invalid topic', 400);
	if (!date) return c.text('Invalid date', 400);

	let body: { emoji?: unknown };
	try {
		body = await c.req.json<{ emoji?: unknown }>();
	} catch {
		return c.text('Invalid request body', 400);
	}

	if (!isValidEmoji(body.emoji)) {
		return c.text('Invalid emoji', 400);
	}

	const snapshot = await recordMood(c.env, topic, date, body.emoji);
	return c.json(snapshot, 200);
});

export default app;
