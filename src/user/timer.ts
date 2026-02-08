import { Bindings } from '../util/types';
import { addBadgeProgress } from './badges';

export class UserTimer {
	state: DurableObjectState;
	env: Bindings;
	timer?: {
		startedAt: number;
		userId: string;
		field: string;
		running: boolean;
	};

	constructor(state: DurableObjectState, env: Bindings) {
		this.state = state;
		this.env = env;
	}

	async fetch(req: Request) {
		const { action, userId, field } = await req.json<{
			action: string;
			userId: string;
			field: string;
		}>();

		if (action === 'start') {
			if (this.timer?.running) {
				return new Response('Already running', { status: 409 });
			}

			this.timer = {
				startedAt: Date.now(),
				userId,
				field,
				running: true
			};

			await this.state.storage.put('timer', this.timer);
			return new Response(null, { status: 204 });
		}

		if (action === 'stop') {
			const timer = await this.state.storage.get<{
				startedAt: number;
				userId: string;
				field: string;
				running: boolean;
			}>('timer');
			if (!timer?.running) {
				return new Response('Not running', { status: 409 });
			}

			const durationMs = Date.now() - timer.startedAt;
			await this.state.storage.delete('timer');
			await applyField(timer.field, timer.userId, durationMs, this.env);

			return Response.json({ durationMs });
		}
	}
}

async function applyField(field: string, userId: string, durationMs: number, bindings: Bindings) {
	const duration = durationMs / 1000; // convert to seconds
	const fieldName = field.split(':')[0];
	const fieldParameter = field.split(':', 2)[1];
	switch (fieldName) {
		case 'articles_read_time':
			// mark as read if >1 minute
			if (duration > 60) {
				await addBadgeProgress(userId, 'articles_read', fieldParameter, bindings.KV);
			}

			// add to articles_read_time
			await addBadgeProgress(userId, 'articles_read_time', duration, bindings.KV);
			break;
	}
}
