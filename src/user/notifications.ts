import { Bindings } from '../util/types';

type TicketRecord = {
	userId: string;
	expiresAt: number;
};

type TicketConsumeResult =
	| { ok: true; userId: string }
	| { ok: false; reason: 'missing' | 'expired' | 'user-mismatch' };

const DEFAULT_TICKET_TTL_SECONDS = 60;
const MAX_TICKET_TTL_SECONDS = 300;
const MIN_TICKET_TTL_SECONDS = 5;
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function noStoreHeaders(headers?: HeadersInit) {
	const finalHeaders = new Headers(headers);
	finalHeaders.set('Cache-Control', 'no-store, max-age=0');
	finalHeaders.set('Pragma', 'no-cache');
	return finalHeaders;
}

function noStoreText(body: string, status: number) {
	return new Response(body, {
		status,
		headers: noStoreHeaders()
	});
}

function noStoreJson(body: unknown, status: number = 200) {
	return Response.json(body, {
		status,
		headers: noStoreHeaders()
	});
}

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

	private ticketKey(ticket: string) {
		return `ticket:${ticket}`;
	}

	private async issueTicket(userId: string, ttlSeconds: number) {
		const boundedTtlSeconds = Math.max(
			MIN_TICKET_TTL_SECONDS,
			Math.min(ttlSeconds, MAX_TICKET_TTL_SECONDS)
		);
		const ticket = crypto.randomUUID();
		const expiresAt = Date.now() + boundedTtlSeconds * 1000;

		await this.state.storage.put(this.ticketKey(ticket), {
			userId,
			expiresAt
		} satisfies TicketRecord);

		return {
			ticket,
			expiresAt,
			ttlSeconds: boundedTtlSeconds
		};
	}

	private async consumeTicket(
		ticket: string,
		expectedUserId: string
	): Promise<TicketConsumeResult> {
		const key = this.ticketKey(ticket);

		// consume inside a transaction so one ticket cannot be used twice under concurrency
		return this.state.storage.transaction(async (txn) => {
			const record = await txn.get<TicketRecord>(key);

			if (!record || typeof record.expiresAt !== 'number' || typeof record.userId !== 'string') {
				return { ok: false as const, reason: 'missing' };
			}

			if (record.expiresAt <= Date.now()) {
				await txn.delete(key);
				return { ok: false as const, reason: 'expired' };
			}

			// delete before identity check to preserve strict one-time semantics
			await txn.delete(key);

			if (record.userId !== expectedUserId) {
				return { ok: false as const, reason: 'user-mismatch' };
			}

			return {
				ok: true as const,
				userId: record.userId
			};
		});
	}

	async fetch(req: Request) {
		const upgrade = req.headers.get('Upgrade')?.toLowerCase();
		const url = new URL(req.url);

		if (req.method === 'POST' && url.pathname === '/ticket') {
			let body: { userId?: string; ttlSeconds?: number };

			try {
				body = await req.json();
			} catch (error) {
				console.warn('[notifier.ticket] invalid ticket issuance payload', {
					error: error instanceof Error ? error.message : String(error)
				});
				return noStoreText('Invalid JSON body', 400);
			}

			if (!body.userId || typeof body.userId !== 'string' || body.userId.trim().length === 0) {
				console.warn('[notifier.ticket] missing or invalid user ID');
				return noStoreText('Invalid user ID', 400);
			}

			const userId = body.userId.trim();
			if (userId.length > 128) {
				console.warn('[notifier.ticket] user ID too long');
				return noStoreText('Invalid user ID', 400);
			}

			const ttlSeconds =
				typeof body.ttlSeconds === 'number' && Number.isFinite(body.ttlSeconds)
					? Math.floor(body.ttlSeconds)
					: DEFAULT_TICKET_TTL_SECONDS;

			let issued: { ticket: string; expiresAt: number; ttlSeconds: number };
			try {
				issued = await this.issueTicket(userId, ttlSeconds);
			} catch (error) {
				console.error('[notifier.ticket] failed to persist ticket', {
					userId,
					error: error instanceof Error ? error.message : String(error)
				});
				return noStoreText('Failed to issue ticket', 500);
			}

			console.log('[notifier.ticket] ticket issued', {
				userId,
				ticket: `${issued.ticket.slice(0, 8)}...`,
				expiresAt: issued.expiresAt,
				ttlSeconds: issued.ttlSeconds
			});

			return noStoreJson({
				ticket: issued.ticket,
				expiresAt: issued.expiresAt
			});
		}

		// upgrade to websocket
		if (req.method === 'GET' && upgrade === 'websocket' && url.pathname === '/connect') {
			const ticket = url.searchParams.get('ticket')?.trim();
			const userId = url.searchParams.get('userId')?.trim();

			if (!ticket) {
				console.warn('[notifier.connect] missing ticket on websocket upgrade');
				return noStoreText('Unauthorized', 401);
			}

			if (!UUID_V4_REGEX.test(ticket)) {
				console.warn('[notifier.connect] invalid ticket format on websocket upgrade', {
					ticket: `${ticket.slice(0, 8)}...`
				});
				return noStoreText('Unauthorized', 401);
			}

			if (!userId || userId.length > 128) {
				console.warn('[notifier.connect] missing or invalid user ID on websocket upgrade', {
					userId
				});
				return noStoreText('Unauthorized', 401);
			}

			let ticketState: TicketConsumeResult;

			try {
				ticketState = await this.consumeTicket(ticket, userId);
			} catch (error) {
				console.error('[notifier.connect] ticket storage failure during websocket upgrade', {
					userId,
					ticket: `${ticket.slice(0, 8)}...`,
					error: error instanceof Error ? error.message : String(error)
				});
				return noStoreText('Internal Server Error', 500);
			}

			if (!ticketState.ok) {
				console.warn('[notifier.connect] rejected websocket upgrade due to invalid ticket', {
					userId,
					ticket: `${ticket.slice(0, 8)}...`,
					reason: ticketState.reason
				});
				return noStoreText('Unauthorized', 401);
			}

			const pair = new WebSocketPair();
			const [client, server] = Object.values(pair);

			server.accept();
			this.sockets.add(server);

			console.log('[notifier.connect] websocket accepted', {
				userId: ticketState.userId,
				activeSockets: this.sockets.size
			});

			server.addEventListener('close', () => {
				this.sockets.delete(server);
				console.log('[notifier.connect] websocket closed', {
					activeSockets: this.sockets.size
				});
			});

			server.addEventListener('error', (event) => {
				console.error('[notifier.connect] websocket server error', {
					error: event.type,
					activeSockets: this.sockets.size
				});
			});

			return new Response(null, {
				status: 101,
				webSocket: client
			});
		}

		// backend push
		if (req.method === 'POST' && url.pathname === '/push') {
			let payload: unknown;

			try {
				payload = await req.json();
			} catch (error) {
				console.warn('[notifier.push] invalid JSON payload', {
					error: error instanceof Error ? error.message : String(error)
				});
				return noStoreText('Invalid JSON body', 400);
			}

			let sentCount = 0;
			let prunedCount = 0;

			console.log('[notifier.push] delivering payload to sockets', {
				activeSockets: this.sockets.size
			});

			for (const ws of this.sockets) {
				try {
					ws.send(JSON.stringify(payload));
					sentCount++;
				} catch (error) {
					this.sockets.delete(ws);
					prunedCount++;
					console.warn('[notifier.push] dropped stale socket after send failure', {
						error: error instanceof Error ? error.message : String(error),
						activeSockets: this.sockets.size
					});
				}
			}

			console.log('[notifier.push] push complete', {
				sentCount,
				prunedCount,
				remainingSockets: this.sockets.size
			});

			return new Response('ok');
		}

		if (url.pathname === '/connect' && req.method !== 'GET') {
			console.warn('[notifier.connect] invalid method for websocket endpoint', {
				method: req.method
			});
			return noStoreText('Method Not Allowed', 405);
		}

		if (upgrade === 'websocket' && url.pathname !== '/connect') {
			console.warn('[notifier.connect] unknown websocket path', {
				path: url.pathname
			});
		}

		return new Response('Not found', { status: 404 });
	}
}
