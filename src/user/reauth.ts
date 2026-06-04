import { Bindings } from '../util/types';
import { normalizeId } from '../util/util';

// short-lived reauth ttl gives users a small window to complete sensitive actions without re-typing
const REAUTH_TTL_SECONDS = 60 * 60; // 1 hour

const KEY = (userId: string) => `auth:last_auth:${normalizeId(userId)}`;

export type ReauthRecord = { at: number };

export async function getLastAuth(env: Bindings, userId: string): Promise<ReauthRecord | null> {
	const raw = await env.KV.get(KEY(userId));
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as ReauthRecord;
		if (!parsed || typeof parsed.at !== 'number') return null;
		return parsed;
	} catch {
		return null;
	}
}

export async function setLastAuth(env: Bindings, userId: string, at: number): Promise<void> {
	const value: ReauthRecord = { at: Number.isFinite(at) ? at : Date.now() };
	await env.KV.put(KEY(userId), JSON.stringify(value), {
		expirationTtl: REAUTH_TTL_SECONDS
	});
}

export async function clearLastAuth(env: Bindings, userId: string): Promise<void> {
	await env.KV.delete(KEY(userId));
}
