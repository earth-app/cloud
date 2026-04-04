import { Hono, type Context } from 'hono';
import { Bindings } from './util/types';
import { bearerAuth } from 'hono/bearer-auth';
import { getCookie } from 'hono/cookie';
import { normalizeId } from './util/util';
import { com } from '@earth-app/ocean';

const ws = new Hono<{ Bindings: Bindings }>();
const TICKET_TTL_SECONDS = 60;
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function setNoStoreHeaders(c: Context) {
	c.header('Cache-Control', 'no-store, max-age=0');
	c.header('Pragma', 'no-cache');
}

function maskValue(value: string, visible: number = 8) {
	if (value.length <= visible) {
		return value;
	}

	return `${value.slice(0, visible)}...`;
}

function extractSessionToken(
	authorizationHeader: string | undefined,
	cookieToken: string | undefined
) {
	const bearerToken = authorizationHeader?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
	const normalizedCookieToken = cookieToken?.trim();

	return bearerToken || normalizedCookieToken || null;
}

ws.post(
	'/notify',
	async (c, next) => {
		const token = c.env.ADMIN_API_KEY;
		return bearerAuth({
			token,
			invalidAuthenticationHeaderMessage: 'Invalid Administrator API Key'
		})(c, next);
	},
	async (c) => {
		let body: { channel?: string; data?: unknown };

		try {
			body = await c.req.json();
		} catch (error) {
			console.warn('[ws.notify] invalid JSON payload', {
				error: error instanceof Error ? error.message : String(error)
			});
			return c.json({ error: 'Invalid JSON body' }, 400);
		}

		if (!body.channel || typeof body.channel !== 'string' || body.channel.trim().length === 0) {
			console.warn('[ws.notify] missing or invalid channel');
			return c.json({ error: 'Invalid channel' }, 400);
		}

		const channel = body.channel.trim();
		const id = c.env.NOTIFIER.idFromName(channel);
		const stub = c.env.NOTIFIER.get(id);

		console.log('[ws.notify] forwarding payload to notifier', {
			channel,
			hasData: body.data !== undefined
		});

		try {
			const response = await stub.fetch('https://do/push', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify(body.data ?? null)
			});

			if (!response.ok) {
				console.warn('[ws.notify] notifier push returned non-success status', {
					channel,
					status: response.status
				});
			}

			return response;
		} catch (error) {
			console.error('[ws.notify] failed to reach notifier durable object', {
				channel,
				error: error instanceof Error ? error.message : String(error)
			});
			return c.json({ error: 'Failed to deliver notification' }, 502);
		}
	}
);

// ticket generation endpoints to avoid logging session tokens in query parameters
ws.get('/users/:id/ticket', async (c) => {
	setNoStoreHeaders(c);

	const rawUserId = c.req.param('id');
	const userId = normalizeId(rawUserId);
	const sessionToken = extractSessionToken(
		c.req.header('Authorization'),
		getCookie(c, 'session_token')
	);

	console.log('[ws.ticket.issue] incoming request', {
		rawUserId,
		normalizedUserId: userId,
		hasAuthorizationHeader: Boolean(c.req.header('Authorization')),
		hasSessionCookie: Boolean(getCookie(c, 'session_token'))
	});

	if (!userId) {
		console.warn('[ws.ticket.issue] invalid user ID', { rawUserId });
		return c.json({ error: 'Invalid user ID' }, 400);
	}

	if (!sessionToken) {
		console.warn('[ws.ticket.issue] missing session token', { userId });
		return c.json({ error: 'Unauthorized' }, 401);
	}

	// Verify session token with primary API
	const mantleUrl = c.env.MANTLE_URL || 'https://api.earth-app.com';
	let userCheck: Response;

	try {
		userCheck = await fetch(`${mantleUrl}/v2/users/current`, {
			headers: {
				Authorization: `Bearer ${sessionToken}`
			}
		});
	} catch (error) {
		console.error('[ws.ticket.issue] failed to validate user session with mantle', {
			userId,
			error: error instanceof Error ? error.message : String(error)
		});
		return c.json({ error: 'Failed to validate session' }, 502);
	}

	if (!userCheck.ok) {
		console.warn('[ws.ticket.issue] mantle session validation failed', {
			userId,
			status: userCheck.status
		});
		return c.json({ error: 'Invalid session' }, 401);
	}

	let userData: {
		id: string;
		account?: { account_type: typeof com.earthapp.account.AccountType.prototype.name };
	};

	try {
		userData = await userCheck.json<{
			id: string;
			account?: { account_type: typeof com.earthapp.account.AccountType.prototype.name };
		}>();
	} catch (error) {
		console.error('[ws.ticket.issue] failed to parse mantle user payload', {
			userId,
			error: error instanceof Error ? error.message : String(error)
		});
		return c.json({ error: 'Failed to validate session' }, 502);
	}

	// Ensure session belongs to the user trying to connect
	if (normalizeId(userData.id) !== userId && userData.account?.account_type !== 'ADMINISTRATOR') {
		console.warn('[ws.ticket.issue] session user mismatch and caller not admin', {
			requestedUserId: userId,
			sessionUserId: normalizeId(userData.id),
			accountType: userData.account?.account_type
		});
		return c.json({ error: 'Forbidden' }, 403);
	}

	const channel = `users:${userId}`;
	const id = c.env.NOTIFIER.idFromName(channel);
	const stub = c.env.NOTIFIER.get(id);

	try {
		const issueTicketResponse = await stub.fetch('https://do/ticket', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				userId,
				ttlSeconds: TICKET_TTL_SECONDS
			})
		});

		if (!issueTicketResponse.ok) {
			const errorMessage = await issueTicketResponse.text();
			console.error('[ws.ticket.issue] notifier rejected ticket issue request', {
				userId,
				status: issueTicketResponse.status,
				errorMessage
			});
			return c.json({ error: 'Unable to issue ticket' }, 500);
		}

		const { ticket } = await issueTicketResponse.json<{
			ticket: string;
			expiresAt: number;
		}>();

		console.log('[ws.ticket.issue] ticket issued', {
			userId,
			ticket: maskValue(ticket),
			ttlSeconds: TICKET_TTL_SECONDS
		});

		return c.json({ ticket });
	} catch (error) {
		console.error('[ws.ticket.issue] failed to issue ticket', {
			userId,
			error: error instanceof Error ? error.message : String(error)
		});
		return c.json({ error: 'Unable to issue ticket' }, 502);
	}
});

// websocket channels

ws.get('/users/:id/notifications', async (c) => {
	setNoStoreHeaders(c);

	const rawUserId = c.req.param('id');
	const userId = normalizeId(rawUserId);
	const ticket = c.req.query('ticket')?.trim();
	const upgrade = c.req.header('Upgrade')?.toLowerCase();

	console.log('[ws.connect] incoming websocket request', {
		rawUserId,
		normalizedUserId: userId,
		hasTicket: Boolean(ticket),
		upgrade
	});

	if (!userId) {
		console.warn('[ws.connect] invalid user ID', { rawUserId });
		return c.json({ error: 'Invalid user ID' }, 400);
	}

	if (!ticket) {
		console.warn('[ws.connect] missing ticket', { userId });
		return c.json({ error: 'Unauthorized' }, 401);
	}

	if (!UUID_V4_REGEX.test(ticket)) {
		console.warn('[ws.connect] invalid ticket format', {
			userId,
			ticket: maskValue(ticket)
		});
		return c.json({ error: 'Invalid ticket' }, 401);
	}

	if (upgrade !== 'websocket') {
		console.warn('[ws.connect] request is not a websocket upgrade', {
			userId,
			upgrade
		});
		return c.json({ error: 'Upgrade Required' }, 426);
	}

	const channel = `users:${userId}`;
	const id = c.env.NOTIFIER.idFromName(channel);
	const stub = c.env.NOTIFIER.get(id);

	const doUrl = new URL('https://do/connect');
	doUrl.searchParams.set('ticket', ticket);
	doUrl.searchParams.set('userId', userId);

	let response: Response;

	try {
		response = await stub.fetch(new Request(doUrl.toString(), c.req.raw));
	} catch (error) {
		console.error('[ws.connect] failed to forward websocket request to notifier', {
			userId,
			ticket: maskValue(ticket),
			error: error instanceof Error ? error.message : String(error)
		});
		return c.json({ error: 'WebSocket connection failed' }, 502);
	}

	if (response.status !== 101) {
		let body = '';

		try {
			body = await response.clone().text();
		} catch {
			body = '';
		}

		console.warn('[ws.connect] notifier rejected websocket upgrade', {
			userId,
			ticket: maskValue(ticket),
			status: response.status,
			body
		});
	} else {
		console.log('[ws.connect] websocket upgraded successfully', {
			userId,
			ticket: maskValue(ticket)
		});
	}

	return response;
});

export default ws;
