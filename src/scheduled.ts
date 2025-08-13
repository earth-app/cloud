import { createArticle, createPrompt, postPrompt } from './boat';
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
	}
}
