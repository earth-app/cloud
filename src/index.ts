import { Hono } from 'hono';

import { cache } from 'hono/cache';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';

import app from './app';
import ws from './ws';
import scheduled from './scheduled';

import * as packageJson from '../package.json';
import { Bindings } from './util/types';
import { poweredBy } from 'hono/powered-by';
import { LiveNotifier } from './user/notifications';
import { UserTimer } from './user/timer';

const main = new Hono<{ Bindings: Bindings }>();

// Middleware

main.use(poweredBy()); // X-Powered-By middleware
main.use(secureHeaders()); // Secure headers middleware
main.use(logger()); // Logger middleware
main.use(
	cors({
		// CORS middleware
		origin: '*',
		allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
		allowHeaders: ['Content-Type', 'Authorization'],
		maxAge: 3600
	})
);
main.use((c, next) => {
	c.res.headers.set('X-Earth-App-Version', packageJson.version);
	c.res.headers.set('X-Earth-App-Name', packageJson.name);

	return next();
}); // Custom headers middleware
main.use(
	'*',
	cache({
		// Cache middleware
		cacheName: 'earth-app-cache',
		cacheControl: 'public, max-age=60, s-maxage=60',
		vary: ['Accept-Encoding', 'Authorization']
	})
);

main.get('/', (c) => c.text('Woosh!'));
main.route('/v1', app);
main.route('/ws', ws);

export { LiveNotifier, UserTimer };

export default {
	fetch: main.fetch,
	scheduled: scheduled
};
