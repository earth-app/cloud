import { Bindings } from '../util/types';

// blacklist storage layout in KV:
//   blacklist:username:<lowercase> -> reason metadata
//   blacklist:email:<lowercase>    -> reason metadata
//   blacklist:index:username       -> JSON array of all entries (for listing)
//   blacklist:index:email          -> JSON array of all entries (for listing)
// the dual index avoids a list operation per call (KV list is paginated and slow).

export type BlacklistKind = 'username' | 'email';

export type BlacklistEntry = {
	kind: BlacklistKind;
	value: string; // lowercased
	original_value: string;
	reason: string;
	added_at: number;
	added_by?: string;
};

const KEY = (kind: BlacklistKind, value: string) => `blacklist:${kind}:${value.toLowerCase()}`;
const INDEX = (kind: BlacklistKind) => `blacklist:index:${kind}`;

function normalize(value: string): string {
	return value.trim().toLowerCase();
}

// supports a tiny wildcard: trailing '*' matches prefixes (e.g. "spam*" blocks "spam-bot", "spammer")
function matches(entry: string, candidate: string): boolean {
	const lc = candidate.toLowerCase();
	if (entry.endsWith('*')) {
		const prefix = entry.slice(0, -1);
		return lc.startsWith(prefix);
	}
	return entry === lc;
}

export async function isBlacklisted(
	env: Bindings,
	kind: BlacklistKind,
	candidate: string
): Promise<BlacklistEntry | null> {
	if (!candidate) return null;
	const value = normalize(candidate);
	// fast exact lookup
	const exact = await env.KV.get(KEY(kind, value));
	if (exact) {
		try {
			return JSON.parse(exact) as BlacklistEntry;
		} catch {
			// fall through to index scan
		}
	}
	// wildcard fallback — only scan when the exact miss happens, not on every call
	const indexRaw = await env.KV.get(INDEX(kind));
	if (!indexRaw) return null;
	let entries: BlacklistEntry[] = [];
	try {
		entries = JSON.parse(indexRaw) as BlacklistEntry[];
	} catch {
		return null;
	}
	for (const e of entries) {
		if (e.value.endsWith('*') && matches(e.value, value)) return e;
	}
	return null;
}

async function readIndex(env: Bindings, kind: BlacklistKind): Promise<BlacklistEntry[]> {
	const raw = await env.KV.get(INDEX(kind));
	if (!raw) return [];
	try {
		return JSON.parse(raw) as BlacklistEntry[];
	} catch {
		return [];
	}
}

async function writeIndex(
	env: Bindings,
	kind: BlacklistKind,
	entries: BlacklistEntry[]
): Promise<void> {
	await env.KV.put(INDEX(kind), JSON.stringify(entries));
}

export async function addToBlacklist(
	env: Bindings,
	kind: BlacklistKind,
	value: string,
	reason: string,
	addedBy?: string
): Promise<BlacklistEntry> {
	const normalized = normalize(value);
	if (!normalized) throw new Error('Empty blacklist value');
	const entry: BlacklistEntry = {
		kind,
		value: normalized,
		original_value: value,
		reason: reason.slice(0, 256),
		added_at: Date.now(),
		added_by: addedBy
	};
	await env.KV.put(KEY(kind, normalized), JSON.stringify(entry));
	const index = await readIndex(env, kind);
	const without = index.filter((e) => e.value !== normalized);
	without.push(entry);
	await writeIndex(env, kind, without);
	return entry;
}

export async function removeFromBlacklist(
	env: Bindings,
	kind: BlacklistKind,
	value: string
): Promise<boolean> {
	const normalized = normalize(value);
	await env.KV.delete(KEY(kind, normalized));
	const index = await readIndex(env, kind);
	const next = index.filter((e) => e.value !== normalized);
	if (next.length === index.length) return false;
	await writeIndex(env, kind, next);
	return true;
}

export async function listBlacklist(
	env: Bindings,
	kind?: BlacklistKind
): Promise<BlacklistEntry[]> {
	const kinds: BlacklistKind[] = kind ? [kind] : ['username', 'email'];
	const all: BlacklistEntry[] = [];
	for (const k of kinds) {
		all.push(...(await readIndex(env, k)));
	}
	return all.sort((a, b) => b.added_at - a.added_at);
}
