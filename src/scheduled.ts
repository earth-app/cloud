import {
	createArticle,
	createArticleQuiz,
	createEvent,
	createPrompt,
	findArticle,
	postEvent,
	retrieveEvents
} from './content/boat';
import { postArticle, postPrompt } from './util/mantle2';
import { retrieveLeaderboard, TOP_LEADERBOARD_COUNT } from './user/journies';
import { retrievePointsLeaderboard, TOP_POINTS_LEADERBOARD_COUNT } from './user/points';
import { Bindings } from './util/types';
import { repairDuplicateBadgeProgress } from './user/badges';
import { expireStaleReports } from './content/reports';

export default async function scheduled(
	controller: ScheduledController,
	env: Bindings,
	ctx: ExecutionContext
) {
	const cron = (controller.cron || '').trim();

	if (cron === '0 * * * *') {
		console.log('Running scheduled task: Create new prompt');
		console.log('Started at', new Date().toISOString());

		const prompt = await createPrompt(env.AI);
		await postPrompt(prompt, env);
		console.log('Created new prompt:', prompt);

		console.log('Finished at', new Date().toISOString());
		return;
	}

	if (cron === '0 */4 * * *') {
		// repair is best-effort; never let it block the article/leaderboard pipeline below
		try {
			const { granted, revoked } = await repairDuplicateBadgeProgress(env);
			if (granted.length > 0 || revoked.length > 0) {
				console.log(
					`Badge repair: backfilled ${granted.length} missed grants, ` +
						`revoked ${revoked.length} stale grants this cycle.`
				);
			}
		} catch (err) {
			console.error('Badge repair task failed; continuing with remaining cron work', err);
		}

		console.log('Running scheduled task: Create new articles (top + bottom ranked)');
		console.log('Started at', new Date().toISOString());

		const [oceans, tags] = await findArticle(env);
		console.log(`Found ${oceans.length} articles (top + bottom ranked) with tags:`, tags);

		for (let i = 0; i < oceans.length; i++) {
			const ocean = oceans[i];
			const rankLabel = i === 0 ? 'top-ranked' : 'bottom-ranked';
			// per-article guard so one failure (AI hiccup, mantle2 down) doesn't abort the rest
			// of the batch or the leaderboard caching below.
			try {
				console.log(`Processing ${rankLabel} article: ${ocean.title}`);

				const article = await createArticle(ocean, env.AI, tags);
				console.log('Created article content:', article.content?.slice(0, 100) + '...');

				// quiz is best-effort — createArticleQuiz returns [] on failure, and the article
				// is still posted (without a quiz) rather than dropped.
				const quiz = await createArticleQuiz(article, env.AI);
				if (quiz.length === 0) {
					console.warn(`No quiz generated for "${article.title}"; posting article without one.`);
				}

				await postArticle(article, quiz.length > 0 ? quiz : null, env);

				console.log(
					`Created new ${rankLabel} article and quiz: "${article.title}" | `,
					article.content?.slice(0, 100) + '...'
				);
			} catch (err) {
				console.error(`Failed to create/post ${rankLabel} article; continuing`, {
					title: ocean?.title,
					err
				});
			}
		}

		console.log('Running scheduled task: Cache leaderboards');
		console.log('Started at', new Date().toISOString());

		const types = ['article', 'prompt', 'event'];
		await Promise.all(
			types.map(async (type) => {
				await retrieveLeaderboard(type, TOP_LEADERBOARD_COUNT, env.KV, env.CACHE);
				console.log(`Cached leaderboard for journey type: ${type}`);
			})
		);

		console.log('Running scheduled task: Cache points leaderboard');
		await retrievePointsLeaderboard(TOP_POINTS_LEADERBOARD_COUNT, env.KV, env.CACHE);
		console.log('Cached impact points leaderboard');

		console.log('Finished at', new Date().toISOString());
		return;
	}

	if (cron === '0 0 */4 * *') {
		console.log('Running scheduled task: Event creation from calendar');
		console.log('Started at', new Date().toISOString());

		const entries = await retrieveEvents();
		const events: Array<Record<string, unknown> | null> = [];
		for (const entry of entries) {
			try {
				const event = await createEvent(entry.entry, entry.date, env);
				if (!event) {
					events.push(null);
					continue;
				}

				const created = await postEvent(event, env, ctx);
				events.push(created as Record<string, unknown>);
			} catch (err) {
				console.error('Failed to create/post scheduled event; continuing', {
					entryName: entry.entry?.name,
					date: entry.date?.toISOString?.(),
					err
				});
				events.push(null);
			}
		}

		for (const event of events) {
			if (!event) continue;
			const name = typeof event.name === 'string' ? event.name : '<unknown>';
			const description = typeof event.description === 'string' ? event.description : '';

			console.log('Created new event:', `"${name}" | `, description.slice(0, 100) + '...');
		}

		console.log('Finished at', new Date().toISOString());
		return;
	}

	if (cron === '0 2 * * *') {
		console.log('Running scheduled task: Expire stale content reports');
		console.log('Started at', new Date().toISOString());

		// pending reports with no admin action for 7 days auto-unflag so content passes as normal
		const expired = await expireStaleReports(env);
		console.log(`Expired ${expired} stale content reports`);

		console.log('Finished at', new Date().toISOString());
		return;
	}

	console.error('No scheduled task matched the cron expression:', controller.cron);
}
