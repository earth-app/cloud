import { Bindings, ExecutionCtxLike } from '../util/types';
import { normalizeId, clampNumber } from '../util/util';
import { sendUserNotification } from './notifications';
import { classifySentiment } from '../content/moderation/ai';
import { trackAndGrant } from './badges';

// mirrors crust/src/shared/types/trailmarks.ts (do not import across repos)

export interface TrailmarkGeo {
	lat: number;
	lng: number;
	place_label?: string;
}

export interface Trailmark {
	id: string;
	author_uid: string;
	author_username: string;
	geo: TrailmarkGeo;
	note: string;
	created_at: string;
	// true when the current viewer has already thanked this note
	thanked_by_me?: boolean;
	// private appreciation signal, only ever returned to the author
	thanks_for_author?: number;
	// set when this note was left as an answer to a daily prompt (surfaces on the prompt)
	prompt_id?: string;
}

export interface TrailmarkCreateInput {
	author_uid: string;
	author_username?: string;
	geo: TrailmarkGeo;
	note: string;
	// optional: also surface this note under a daily prompt as a 'from outside' response
	prompt_id?: string;
}

// notes linger for the next visitor; long enough to matter, bounded so the map self-cleans
const TRAILMARK_TTL = 60 * 60 * 24 * 180; // 180 days
const MAX_NOTE_LENGTH = 240;
const MAX_PLACE_LABEL = 80;
const DEFAULT_RADIUS = 500; // meters
const MAX_RADIUS = 2000; // hard cap ~2km so a query can't scan the planet
const MAX_RESULTS = 50;
const MAX_USER_INDEX = 200; // cap a user's own-mark index so it can't grow unbounded
const MAX_PREFIX_SCAN = 256; // safety bound on covering buckets (only trips near the poles)

// precision-5 geohash bucket: ~4.9km cell at the equator, > the 2km radius cap so a
// query's bounding box spans at most a small neighborhood of cells
const BUCKET_PRECISION = 5;
const GEOHASH_BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';
// precision-5 cell is ~0.0439 deg on each axis (constant in degrees, not meters)
const CELL_DEG = 360 / Math.pow(2, 13);
const METERS_PER_DEG_LAT = 111320;

export function geohashEncode(lat: number, lng: number, precision = BUCKET_PRECISION): string {
	let idx = 0;
	let bit = 0;
	let evenBit = true;
	let hash = '';
	let latMin = -90;
	let latMax = 90;
	let lngMin = -180;
	let lngMax = 180;

	while (hash.length < precision) {
		if (evenBit) {
			const mid = (lngMin + lngMax) / 2;
			if (lng >= mid) {
				idx = idx * 2 + 1;
				lngMin = mid;
			} else {
				idx = idx * 2;
				lngMax = mid;
			}
		} else {
			const mid = (latMin + latMax) / 2;
			if (lat >= mid) {
				idx = idx * 2 + 1;
				latMin = mid;
			} else {
				idx = idx * 2;
				latMax = mid;
			}
		}
		evenBit = !evenBit;
		if (++bit === 5) {
			hash += GEOHASH_BASE32[idx];
			bit = 0;
			idx = 0;
		}
	}
	return hash;
}

export function distanceMeters(
	[lat1, lng1]: [number, number],
	[lat2, lng2]: [number, number]
): number {
	const toRad = (d: number) => (d * Math.PI) / 180;
	const earth = 6371000;
	const dLat = toRad(lat2 - lat1);
	const dLng = toRad(lng2 - lng1);
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
	return 2 * earth * Math.asin(Math.min(1, Math.sqrt(a)));
}

function clampLat(lat: number): number {
	return Math.max(-90, Math.min(90, lat));
}

function wrapLng(lng: number): number {
	let x = lng;
	while (x > 180) x -= 360;
	while (x < -180) x += 360;
	return x;
}

export function isValidLatLng(lat: unknown, lng: unknown): lat is number {
	return (
		typeof lat === 'number' &&
		typeof lng === 'number' &&
		Number.isFinite(lat) &&
		Number.isFinite(lng) &&
		lat >= -90 &&
		lat <= 90 &&
		lng >= -180 &&
		lng <= 180
	);
}

// every precision-5 bucket whose cell overlaps the query's bounding box. walks the box
// on a sub-cell grid so no overlapping cell is skipped, even at high latitude where a
// longitude cell shrinks in meters (the box then spans more cells)
export function coveringBuckets(lat: number, lng: number, radiusM: number): string[] {
	const dLat = radiusM / METERS_PER_DEG_LAT;
	const cosLat = Math.max(Math.cos((lat * Math.PI) / 180), 0.01);
	const dLng = radiusM / (METERS_PER_DEG_LAT * cosLat);
	const step = CELL_DEG * 0.9;

	const set = new Set<string>();
	for (let dy = -dLat; dy <= dLat + 1e-9; dy += step) {
		const plat = clampLat(lat + dy);
		for (let dx = -dLng; dx <= dLng + 1e-9; dx += step) {
			set.add(geohashEncode(plat, wrapLng(lng + dx)));
			if (set.size >= MAX_PREFIX_SCAN) return [...set];
		}
	}
	// guarantee the exact center + box corners are covered
	set.add(geohashEncode(clampLat(lat), wrapLng(lng)));
	set.add(geohashEncode(clampLat(lat + dLat), wrapLng(lng + dLng)));
	set.add(geohashEncode(clampLat(lat + dLat), wrapLng(lng - dLng)));
	set.add(geohashEncode(clampLat(lat - dLat), wrapLng(lng + dLng)));
	set.add(geohashEncode(clampLat(lat - dLat), wrapLng(lng - dLng)));
	return [...set];
}

// small profanity/slur set masked whole-word; the upstream obscenity library is the
// primary filter, this just keeps a raw cloud write from surfacing the obvious cases
const PROFANITY = [
	'fuck',
	'shit',
	'bitch',
	'cunt',
	'asshole',
	'bastard',
	'dick',
	'piss',
	'slut',
	'whore',
	'nigger',
	'faggot',
	'retard'
];

export function censorNote(raw: string): string {
	let s = (raw || '')
		.normalize('NFC')
		// strip control chars
		.replace(/[\u0000-\u001F\u007F]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, MAX_NOTE_LENGTH);

	for (const word of PROFANITY) {
		const re = new RegExp(`\\b${word}\\b`, 'gi');
		s = s.replace(re, (m) => m[0] + '*'.repeat(Math.max(1, m.length - 1)));
	}
	return s;
}

// the id embeds its bucket as the first BUCKET_PRECISION chars, so a lookup by id alone
// (the thank route) resolves the geo key without a scan
function bucketOf(id: string): string {
	return id.slice(0, BUCKET_PRECISION);
}

const markKey = (id: string) => `trailmark:${bucketOf(id)}:${id}`;
const userKey = (uid: string) => `trailmark:user:${normalizeId(uid)}`;
const thanksKey = (id: string) => `trailmark:thanks:${id}`;
const thankedKey = (id: string, uid: string) => `trailmark:thanked:${id}:${normalizeId(uid)}`;

// opaque, filesystem-safe prompt id so the index key can't be poisoned by odd input
function sanitizePromptId(raw: unknown): string | null {
	if (typeof raw !== 'string') return null;
	const clean = raw
		.trim()
		.replace(/[^A-Za-z0-9_-]/g, '')
		.slice(0, 64);
	return clean || null;
}

const promptPrefix = (promptId: string) => `trailmark:prompt:${promptId}:`;
const promptKey = (promptId: string, id: string) => `${promptPrefix(promptId)}${id}`;

type GeoMeta = { lat: number; lng: number; created_at: string };
type PromptMeta = { created_at: string };

function genSuffix(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(8));
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

export type CreateTrailmarkResult =
	| { ok: true; trailmark: Trailmark }
	| { ok: false; reason: 'invalid_geo' | 'empty_note' | 'negative_sentiment' };

export async function createTrailmark(
	env: Bindings,
	input: TrailmarkCreateInput,
	ctx?: ExecutionCtxLike
): Promise<CreateTrailmarkResult> {
	const lat = input?.geo?.lat;
	const lng = input?.geo?.lng;
	if (!isValidLatLng(lat, lng)) return { ok: false, reason: 'invalid_geo' };

	const note = censorNote(input?.note ?? '');
	if (!note) return { ok: false, reason: 'empty_note' };

	const authorUid = normalizeId(input.author_uid);
	if (!authorUid) return { ok: false, reason: 'invalid_geo' };

	// keep the trail kind + encouraging; a confidently-negative note is turned away
	// (fail-open inside classifySentiment, so infra trouble never blocks a post)
	const sentiment = await classifySentiment(env, note);
	if (sentiment.negative) return { ok: false, reason: 'negative_sentiment' };

	const placeLabel =
		typeof input.geo.place_label === 'string' && input.geo.place_label.trim()
			? input.geo.place_label.trim().slice(0, MAX_PLACE_LABEL)
			: undefined;

	const promptId = sanitizePromptId(input.prompt_id);

	const bucket = geohashEncode(lat, lng);
	const id = `${bucket}${genSuffix()}`;

	const trailmark: Trailmark = {
		id,
		author_uid: authorUid,
		author_username: (input.author_username || 'someone').slice(0, 64),
		geo: { lat, lng, ...(placeLabel ? { place_label: placeLabel } : {}) },
		note,
		created_at: new Date().toISOString(),
		...(promptId ? { prompt_id: promptId } : {})
	};

	const meta: GeoMeta = { lat, lng, created_at: trailmark.created_at };

	const writes: Promise<unknown>[] = [
		env.KV.put(markKey(id), JSON.stringify(trailmark), {
			expirationTtl: TRAILMARK_TTL,
			metadata: meta
		}),
		appendToUserIndex(env, authorUid, trailmark)
	];

	// link the note to the prompt so it surfaces under 'from outside'; id resolves the mark
	if (promptId) {
		const promptMeta: PromptMeta = { created_at: trailmark.created_at };
		writes.push(
			env.KV.put(promptKey(promptId, id), '1', {
				expirationTtl: TRAILMARK_TTL,
				metadata: promptMeta
			})
		);
	}

	await Promise.all(writes);

	// badge hook: total trailmarks left by this author
	await trackAndGrant(authorUid, 'trailmarks_left', 1, env, ctx);

	return { ok: true, trailmark };
}

async function appendToUserIndex(env: Bindings, uid: string, mark: Trailmark): Promise<void> {
	const existing = (await env.KV.get<Trailmark[]>(userKey(uid), 'json')) ?? [];
	const list = Array.isArray(existing) ? existing : [];
	const next = [mark, ...list].slice(0, MAX_USER_INDEX);
	await env.KV.put(userKey(uid), JSON.stringify(next), { expirationTtl: TRAILMARK_TTL });
}

export async function getNearbyTrailmarks(
	env: Bindings,
	lat: number,
	lng: number,
	radius: number = DEFAULT_RADIUS,
	viewerUid?: string
): Promise<Trailmark[]> {
	if (!isValidLatLng(lat, lng)) return [];
	const radiusM = clampNumber(radius, 1, MAX_RADIUS, DEFAULT_RADIUS);
	const viewer = viewerUid ? normalizeId(viewerUid) : '';

	const buckets = coveringBuckets(lat, lng, radiusM);

	// gather in-radius candidates from each bucket's metadata (no full read yet)
	const candidates: { id: string; dist: number }[] = [];
	const seen = new Set<string>();
	for (const bucket of buckets) {
		const page = await env.KV.list<GeoMeta>({ prefix: `trailmark:${bucket}:` });
		for (const key of page.keys) {
			const id = key.name.slice(key.name.lastIndexOf(':') + 1);
			if (seen.has(id)) continue;
			const m = key.metadata;
			if (!m || typeof m.lat !== 'number' || typeof m.lng !== 'number') {
				// no metadata (older write) - fall back to including, filtered after full read
				seen.add(id);
				candidates.push({ id, dist: 0 });
				continue;
			}
			const dist = distanceMeters([lat, lng], [m.lat, m.lng]);
			if (dist <= radiusM) {
				seen.add(id);
				candidates.push({ id, dist });
			}
		}
	}

	candidates.sort((a, b) => a.dist - b.dist);
	const picked = candidates.slice(0, MAX_RESULTS);

	const records = await Promise.all(
		picked.map(async ({ id }) => {
			const rec = await env.KV.get<Trailmark>(markKey(id), 'json');
			return rec;
		})
	);

	const out: Trailmark[] = [];
	for (const rec of records) {
		if (!rec || typeof rec.note !== 'string') continue;
		// re-verify radius for any metadata-less fallback candidate
		if (rec.geo && !within(lat, lng, rec.geo, radiusM)) continue;
		out.push(await enrichForViewer(env, rec, viewer));
	}
	return out;
}

// shapes a stored mark for a viewer: the private thanks tally goes only to the author,
// every other viewer gets thanked_by_me. shared by nearby + prompt lookups
async function enrichForViewer(env: Bindings, rec: Trailmark, viewer: string): Promise<Trailmark> {
	const enriched: Trailmark = {
		id: rec.id,
		author_uid: rec.author_uid,
		author_username: rec.author_username,
		geo: rec.geo,
		note: rec.note,
		created_at: rec.created_at,
		...(rec.prompt_id ? { prompt_id: rec.prompt_id } : {})
	};

	const isAuthor = viewer !== '' && normalizeId(rec.author_uid) === viewer;
	if (isAuthor) {
		enriched.thanks_for_author = await readThanks(env, rec.id);
		enriched.thanked_by_me = false;
	} else if (viewer !== '') {
		enriched.thanked_by_me = await hasThanked(env, rec.id, viewer);
	}
	return enriched;
}

// notes left as answers to a daily prompt, most-recent first (capped). same thanks
// semantics as nearby; the prompt index stores ids, the mark id resolves the full record
export async function getTrailmarksForPrompt(
	env: Bindings,
	promptId: string,
	viewerUid?: string
): Promise<Trailmark[]> {
	const pid = sanitizePromptId(promptId);
	if (!pid) return [];
	const viewer = viewerUid ? normalizeId(viewerUid) : '';

	const page = await env.KV.list<PromptMeta>({ prefix: promptPrefix(pid) });
	const entries = page.keys
		.map((k) => ({
			id: k.name.slice(k.name.lastIndexOf(':') + 1),
			created_at: k.metadata?.created_at || ''
		}))
		.sort((a, b) => Date.parse(b.created_at || '') - Date.parse(a.created_at || ''))
		.slice(0, MAX_RESULTS);

	const records = await Promise.all(
		entries.map(({ id }) => env.KV.get<Trailmark>(markKey(id), 'json'))
	);

	const out: Trailmark[] = [];
	for (const rec of records) {
		if (!rec || typeof rec.note !== 'string') continue;
		out.push(await enrichForViewer(env, rec, viewer));
	}
	return out;
}

function within(lat: number, lng: number, geo: TrailmarkGeo, radiusM: number): boolean {
	if (typeof geo.lat !== 'number' || typeof geo.lng !== 'number') return false;
	return distanceMeters([lat, lng], [geo.lat, geo.lng]) <= radiusM;
}

async function readThanks(env: Bindings, id: string): Promise<number> {
	const raw = await env.KV.get(thanksKey(id));
	const n = raw ? Number(raw) : 0;
	return Number.isFinite(n) && n > 0 ? n : 0;
}

async function hasThanked(env: Bindings, id: string, uid: string): Promise<boolean> {
	const v = await env.KV.get(thankedKey(id, uid));
	return v !== null;
}

export async function getTrailmark(env: Bindings, id: string): Promise<Trailmark | null> {
	if (!id) return null;
	return await env.KV.get<Trailmark>(markKey(id), 'json');
}

// the author's own trailmark index (newest first, capped)
export async function getUserTrailmarks(env: Bindings, uid: string): Promise<Trailmark[]> {
	const raw = await env.KV.get<Trailmark[]>(userKey(uid), 'json');
	return Array.isArray(raw) ? raw : [];
}

export type ThankResult =
	| { ok: true; thanks: number; authorUid: string; placeLabel?: string }
	| { ok: false; reason: 'not_found' | 'already_thanked' | 'self' };

// one-thank gate + private counter increment. the gate guarantees exactly-once, so the
// author notification fires at most once per (note, thanker)
export async function thankTrailmark(
	env: Bindings,
	id: string,
	thankerUid: string,
	thankerUsername?: string,
	ctx?: { waitUntil(p: Promise<unknown>): void }
): Promise<ThankResult> {
	const mark = await getTrailmark(env, id);
	if (!mark) return { ok: false, reason: 'not_found' };

	const uid = normalizeId(thankerUid);
	if (!uid) return { ok: false, reason: 'not_found' };
	if (uid === normalizeId(mark.author_uid)) return { ok: false, reason: 'self' };

	if (await hasThanked(env, id, uid)) {
		return { ok: false, reason: 'already_thanked' };
	}

	// set the gate first so a racing duplicate can't double-count
	await env.KV.put(thankedKey(id, uid), '1', { expirationTtl: TRAILMARK_TTL });

	// kv has no atomic increment; read-modify-write. last-writer-wins can rarely drop a
	// concurrent increment - acceptable for a private, non-vanity appreciation signal
	const next = (await readThanks(env, id)) + 1;
	await env.KV.put(thanksKey(id), String(next), { expirationTtl: TRAILMARK_TTL });

	const placeLabel = mark.geo?.place_label;
	const notify = sendUserNotification(
		env,
		normalizeId(mark.author_uid),
		'Someone Thanked Your Note',
		placeLabel
			? `A visitor thanked the note you left at ${placeLabel}.`
			: 'A visitor thanked a note you left along the way.',
		undefined,
		'trailmark',
		thankerUsername ? `@${thankerUsername}` : 'trailmark'
	).catch(() => {});

	if (ctx) ctx.waitUntil(notify);
	else await notify;

	// badge hook: the author's note earned appreciation
	await trackAndGrant(normalizeId(mark.author_uid), 'trailmarks_thanked', 1, env, ctx);

	return {
		ok: true,
		thanks: next,
		authorUid: normalizeId(mark.author_uid),
		...(placeLabel ? { placeLabel } : {})
	};
}

export const TRAILMARK_LIMITS = {
	TTL: TRAILMARK_TTL,
	MAX_NOTE_LENGTH,
	DEFAULT_RADIUS,
	MAX_RADIUS,
	MAX_RESULTS,
	BUCKET_PRECISION
};
