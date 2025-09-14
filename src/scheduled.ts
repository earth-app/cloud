import {
	createActivityData,
	createArticle,
	createNewActivity,
	createPrompt,
	postActivity,
	postPrompt
} from './boat';
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

	if (controller.cron === '*/10 * * * *') {
		console.log('Running scheduled task: Create new activity');
		ctx.waitUntil(
			new Promise<void>(async (resolve) => {
				const id = await createNewActivity(env);
				if (!id || id.length > 75 || id.includes(':') || id.includes(',')) {
					console.warn(`Failed to generate new activity on cron job: received ${id}`);
					return;
				}

				const activity = id.replace(/_/g, ' ');

				const data = await createActivityData(id, activity, env.AI);
				await postActivity(env, data);

				console.log('Created new activity:', id);
				resolve();
			})
		);
	}

	return new Response('No cron job matched', { status: 404 });
}
