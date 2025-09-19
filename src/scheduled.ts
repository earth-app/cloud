import { createArticle, createPrompt, findArticle, postArticle, postPrompt } from './boat';
import { Bindings } from './types';

export default async function scheduled(
	controller: ScheduledController,
	env: Bindings,
	ctx: ExecutionContext
) {
	if (controller.cron === '0 * * * *') {
		console.log('Running scheduled task: Create new prompt');
		ctx.waitUntil(
			new Promise<void>(async (resolve) => {
				const prompt = await createPrompt(env.AI);
				await postPrompt(prompt, env);
				console.log('Created new prompt:', prompt);

				resolve();
			})
		);

		return;
	}

	if (controller.cron === '0 */5 * * *') {
		console.log('Running scheduled task: Create new article');
		ctx.waitUntil(
			new Promise<void>(async (resolve) => {
				const [article, tags] = await findArticle(env);
				console.log('Found article and tags:', article.title, tags);

				const created = await createArticle(article, env.AI, tags);
				await postArticle(created, env);
				console.log(
					'Created new article:',
					`"${created.title}" | `,
					created.content?.slice(0, 100) + '...'
				);

				resolve();
			})
		);

		return;
	}

	console.error('No scheduled task matched the cron expression:', controller.cron);
}
