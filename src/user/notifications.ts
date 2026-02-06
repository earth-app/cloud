import { Bindings } from '../util/types';

export async function sendUserNotification(
	bindings: Bindings,
	id: string,
	title: string,
	description: string,
	link?: string,
	type: string = 'info',
	source: string = 'cloud'
) {
	const url = `${bindings.MANTLE_URL || 'https://api.earth-app.com'}/v2/users/${id}/notifications`;
	const body = {
		title,
		description,
		link,
		type,
		source
	};

	const res = fetch(url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${bindings.ADMIN_API_KEY}`
		},
		body: JSON.stringify(body)
	});

	return res;
}

export class LiveNotifier {
	state: DurableObjectState;
	sockets: Set<WebSocket>;

	constructor(state: DurableObjectState) {
		this.state = state;
		this.sockets = new Set();
	}

	async fetch(req: Request) {
		const upgrade = req.headers.get('Upgrade');

		// upgrade to websocket
		if (upgrade === 'websocket') {
			const pair = new WebSocketPair();
			const [client, server] = Object.values(pair);

			server.accept();
			this.sockets.add(server);

			server.addEventListener('close', () => {
				this.sockets.delete(server);
			});

			return new Response(null, {
				status: 101,
				webSocket: client
			});
		}

		// backend push
		if (req.method === 'POST') {
			const payload = await req.json();

			for (const ws of this.sockets) {
				try {
					ws.send(JSON.stringify(payload));
				} catch {
					this.sockets.delete(ws);
				}
			}

			return new Response('ok');
		}

		return new Response('Not found', { status: 404 });
	}
}
