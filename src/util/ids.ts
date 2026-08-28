import { Bindings } from './types';
import { normalizeId } from './util';

// mantle2 used to publish a padded drupal integer and now publishes the entity uuid with the
// dashes stripped, so both shapes arrive for data KV still keys on the numeric one. a hex id is
// translated once and cached forever; nothing here re-keys KV.

// the upper bound replaces the old per-route length guards; there is no lower bound because the
// canonical form of a padded id is short ("42")
export const NUMERIC_ID = /^\d{1,50}$/;
export const UUID_HEX_ID = /^[0-9a-f]{32}$/;

export function isNumericId(id: string): boolean {
	return NUMERIC_ID.test(id);
}

export function isUuidHexId(id: string): boolean {
	return UUID_HEX_ID.test(id);
}

/** Either shape mantle2 may have issued. Route guards use this in place of a bare `/^\d+$/`. */
export function isUserIdShape(id: string | undefined | null): id is string {
	if (!id) return false;
	return isNumericId(id) || isUuidHexId(id);
}

/** Message every route shares, so the two shapes are described the same way everywhere. */
export const USER_ID_SHAPE_MESSAGE = 'ID must be numeric or a 32-character uuid (dashes stripped)';

export type EntityKind = 'user' | 'article' | 'event' | 'prompt';

// users predate the shared content route and keep their own path
const LOOKUP_PATH: Record<EntityKind, string> = {
	user: 'users',
	article: 'article',
	event: 'event',
	prompt: 'prompt'
};

// the user keyspace predates the others and holds live entries, so it keeps its shape
const aliasKey = (kind: EntityKind, hex: string) =>
	kind === 'user' ? `user:alias:${hex}` : `${kind}:alias:${hex}`;

// admin-authenticated because the numeric id is deliberately off the public surface
async function lookupNumericId(
	env: Bindings,
	kind: EntityKind,
	hex: string
): Promise<string | null> {
	const base = env.MANTLE_URL || 'https://api.earth-app.com';
	try {
		const res = await fetch(`${base}/v2/admin/${LOOKUP_PATH[kind]}/${hex}/internal_id`, {
			headers: { Accept: 'application/json', Authorization: `Bearer ${env.ADMIN_API_KEY}` }
		});
		if (!res.ok) {
			console.warn('[resolveId] mantle2 could not resolve uuid', { kind, hex, status: res.status });
			return null;
		}

		const body = (await res.json()) as { id?: unknown };
		const numeric = normalizeId(typeof body?.id === 'string' ? body.id : String(body?.id ?? ''));
		return isNumericId(numeric) ? numeric : null;
	} catch (err) {
		console.error('[resolveId] failed to reach mantle2', {
			kind,
			hex,
			error: err instanceof Error ? err.message : String(err)
		});
		return null;
	}
}

/** Canonical KV-facing id for whichever shape the caller sent; null means no such entity. */
export async function resolveEntityId(
	env: Bindings,
	kind: EntityKind,
	id: string
): Promise<string | null> {
	if (!id) return null;
	if (isNumericId(id)) return normalizeId(id);
	if (!isUuidHexId(id)) return null;

	const cached = await env.KV.get(aliasKey(kind, id));
	if (cached && isNumericId(cached)) return cached;

	const numeric = await lookupNumericId(env, kind, id);
	if (!numeric) return null;

	// permanent: a uuid and its integer id are both immutable
	await env.KV.put(aliasKey(kind, id), numeric);
	return numeric;
}

export const resolveUserId = (env: Bindings, id: string) => resolveEntityId(env, 'user', id);

// mantle2 pushes this on creation so the first request from a new entity skips the lookup
export async function rememberAlias(
	env: Bindings,
	kind: EntityKind,
	hex: string,
	numericId: string
): Promise<boolean> {
	if (!isUuidHexId(hex)) return false;

	const numeric = normalizeId(numericId);
	if (!isNumericId(numeric)) return false;

	await env.KV.put(aliasKey(kind, hex), numeric);
	return true;
}

export const rememberUserAlias = (env: Bindings, hex: string, numericId: string) =>
	rememberAlias(env, 'user', hex, numericId);
