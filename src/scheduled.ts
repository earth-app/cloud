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
import { retrieveLeaderboard } from './user/journies';
import { Bindings } from './util/types';

export default async function scheduled(
	controller: ScheduledController,
	env: Bindings,
	ctx: ExecutionContext
) {
	if (controller.cron === '0 * * * *') {
		console.log('Running scheduled task: Create new prompt');
		ctx.waitUntil(
			(async () => {
				console.log('Started at', new Date().toISOString());

				const prompt = await createPrompt(env.AI);
				await postPrompt(prompt, env);
				console.log('Created new prompt:', prompt);

				console.log('Finished at', new Date().toISOString());
			})()
		);

		return;
	}

	if (controller.cron === '0 */4 * * *') {
		console.log('Running scheduled task: Create new article');
		ctx.waitUntil(
			(async () => {
				console.log('Started at', new Date().toISOString());

				const [ocean, tags] = await findArticle(env);
				console.log('Found article and tags:', ocean.title, tags);

				const article = await createArticle(ocean, env.AI, tags);
				const quiz = await createArticleQuiz(article, env.AI);
				await postArticle(article, quiz, env);

				console.log(
					'Created new article:',
					`"${article.title}" | `,
					article.content?.slice(0, 100) + '...'
				);

				console.log('Finished at', new Date().toISOString());
			})()
		);

		console.log('Running scheduled task: Cache journies leaderboard');
		ctx.waitUntil(
			(async () => {
				console.log('Started at', new Date().toISOString());

				const types = ['article', 'prompt', 'event'];
				Promise.all(
					types.map(async (type) => {
						await retrieveLeaderboard(type, env.KV, env.CACHE);
						console.log(`Cached leaderboard for journey type: ${type}`);
					})
				);

				console.log('Finished at', new Date().toISOString());
			})()
		);

		return;
	}

	if (controller.cron === '0 0 */14 * *') {
		console.log('Running scheduled task: Event creation from calendar');
		ctx.waitUntil(
			(async () => {
				console.log('Started at', new Date().toISOString());

				const entries = retrieveEvents();
				const promises = entries.map(async (entry) => {
					const event = await createEvent(entry.entry, entry.date, env);
					if (!event) return null;
					return await postEvent(event, env);
				});

				const events = await Promise.all(promises);
				for (const event of events) {
					if (!event) continue;

					console.log(
						'Created new event:',
						`"${event.name}" | `,
						event.description?.slice(0, 100) + '...'
					);
				}

				console.log('Finished at', new Date().toISOString());
			})()
		);

		return;
	}

	console.error('No scheduled task matched the cron expression:', controller.cron);
}
