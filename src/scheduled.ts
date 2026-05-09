import {
	createArticle,
	createArticleQuiz,
	createEvent,
	createPrompt,
	findArticle,
	postArticle,
	postEvent,
	postPrompt,
	retrieveEvents
} from './content/boat';
import { retrieveLeaderboard, TOP_LEADERBOARD_COUNT } from './user/journies';
import { Bindings } from './util/types';
import { repairDuplicateBadgeProgress } from './user/badges';

export default async function scheduled(
	controller: ScheduledController,
	env: Bindings,
	ctx: ExecutionContext
) {
	const cron = (controller.cron || '').trim();

	if (cron === '*/12 * * * *') {
		console.log('Running scheduled task: Create new prompt');
		console.log('Started at', new Date().toISOString());

		const prompt = await createPrompt(env.AI);
		await postPrompt(prompt, env);
		console.log('Created new prompt:', prompt);

		console.log('Finished at', new Date().toISOString());
		return;
	}

	if (cron === '0 * * * *') {
		await repairDuplicateBadgeProgress(env.KV);

		console.log('Running scheduled task: Create new articles (top 3 + bottom 2 ranked)');
		console.log('Started at', new Date().toISOString());

		const [oceans, tags] = await findArticle(env);
		console.log(`Found ${oceans.length} articles (top 3 + bottom 2 ranked) with tags:`, tags);

		for (let i = 0; i < oceans.length; i++) {
			const ocean = oceans[i];
			const rankLabel = i < 3 ? `top-${i + 1}-ranked` : `bottom-${i - 2}-ranked`;
			console.log(`Processing ${rankLabel} article: ${ocean.title}`);

			const article = await createArticle(ocean, env.AI, tags);
			console.log('Created article content:', article.content?.slice(0, 100) + '...');

			const quiz = await createArticleQuiz(article, env.AI);
			console.log('Created article quiz with questions:', quiz);

			await postArticle(article, quiz.length > 0 ? quiz : null, env);

			console.log(
				`Created new ${rankLabel} article and quiz: "${article.title}" | `,
				article.content?.slice(0, 100) + '...'
			);
		}

		console.log('Finished at', new Date().toISOString());
		return;
	}

	if (cron === '0 */4 * * *') {
		console.log('Running scheduled task: Cache leaderboards');
		console.log('Started at', new Date().toISOString());

		const types = ['article', 'prompt', 'event'];
		await Promise.all(
			types.map(async (type) => {
				await retrieveLeaderboard(type, TOP_LEADERBOARD_COUNT, env.KV, env.CACHE);
				console.log(`Cached leaderboard for journey type: ${type}`);
			})
		);

		console.log('Finished at', new Date().toISOString());
		return;
	}

	if (cron === '0 0 */2 * *') {
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

	console.error('No scheduled task matched the cron expression:', controller.cron);
}
