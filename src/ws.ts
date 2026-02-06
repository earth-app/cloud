import { Hono } from 'hono';
import { Bindings } from './util/types';
import { bearerAuth } from 'hono/bearer-auth';
import { getCookie } from 'hono/cookie';
import { normalizeId } from './util/util';
import { com } from '@earth-app/ocean';

const ws = new Hono<{ Bindings: Bindings }>();

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
		const { channel, data } = await c.req.json();
		const id = c.env.NOTIFIER.idFromName(channel);
		const stub = c.env.NOTIFIER.get(id);

		return stub.fetch('https://do/push', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(data)
		});
	}
);

ws.get('/users/:id', async (c) => {
	const userId = normalizeId(c.req.param('id'));
	const sessionToken = getCookie(c, 'session_token');

	if (!userId) {
		return c.json({ error: 'Invalid user ID' }, 400);
	}

	if (!sessionToken) {
		return c.json({ error: 'Unauthorized' }, 401);
	}

	// Verify session token with primary API
	const mantleUrl = c.env.MANTLE_URL || 'https://api.earth-app.com';
	const userCheck = await fetch(`${mantleUrl}/v2/users/current`, {
		headers: {
			Authorization: `Bearer ${sessionToken}`
		}
	});

	if (!userCheck.ok) {
		return c.json({ error: 'Invalid session' }, 401);
	}

	const userData = await userCheck.json<{
		id: string;
		account: { account_type: typeof com.earthapp.account.AccountType.prototype.name };
	}>();

	// Ensure session belongs to the user trying to connect
	if (normalizeId(userData.id) !== userId && userData.account.account_type !== 'ADMINISTRATOR') {
		return c.json({ error: 'Forbidden' }, 403);
	}

	const channel = `users:${userId}`;
	const id = c.env.NOTIFIER.idFromName(channel);
	const stub = c.env.NOTIFIER.get(id);

	return stub.fetch(c.req.raw);
});

export default ws;
