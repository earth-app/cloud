export class UserTimer {
	state: DurableObjectState;
	timer?: {
		startedAt: number;
		userId: string;
		running: boolean;
	};

	constructor(state: DurableObjectState) {
		this.state = state;
	}

	async fetch(req: Request) {
		const { action, userId } = await req.json<{ action: string; userId: string }>();

		if (action === 'start') {
			if (this.timer?.running) {
				return new Response('Already running', { status: 409 });
			}

			this.timer = {
				startedAt: Date.now(),
				userId,
				running: true
			};

			await this.state.storage.put('timer', this.timer);
			return new Response(null, { status: 204 });
		}

		if (action === 'stop') {
			const timer = await this.state.storage.get<{
				startedAt: number;
				userId: string;
				running: boolean;
			}>('timer');
			if (!timer?.running) {
				return new Response('Not running', { status: 409 });
			}

			const durationMs = Date.now() - timer.startedAt;
			await this.state.storage.delete('timer');

			return Response.json({ durationMs });
		}
	}
}
