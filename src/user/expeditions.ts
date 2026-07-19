import { Bindings } from '../util/types';
import { normalizeId, clampInt, clampNumber } from '../util/util';

export type ExpeditionGoal = 'nature_minutes' | 'trails' | 'quests';
export type ExpeditionStatus = 'active' | 'complete' | 'expired';

export interface ExpeditionContributor {
	uid: string;
	username: string;
	contribution: number;
	last_contributed_at?: string;
}

export interface Expedition {
	id: string;
	owner_uid: string;
	title: string;
	goal: ExpeditionGoal;
	target: number;
	progress: number;
	contributors: ExpeditionContributor[];
	status: ExpeditionStatus;
	starts_at: string;
	ends_at: string;
}

export type GardenElementKind = 'tree' | 'flower' | 'water' | 'stone' | 'creature' | 'star';

export interface GardenElement {
	kind: GardenElementKind;
	seed: number;
	growth: number; // 0..1 bloom
	contributor_uid?: string;
}

export interface CircleGarden {
	owner_uid: string;
	level: number;
	total_minutes: number;
	elements: GardenElement[];
	animated: boolean;
	updated_at: string;
}

const GOALS: ExpeditionGoal[] = ['nature_minutes', 'trails', 'quests'];

// each goal unit is worth this many minutes-equivalent when growing the garden
// (a completed trail contributes 1 to a `trails` goal, ~its unhurried presence in minutes)
const GOAL_MINUTE_WEIGHT: Record<ExpeditionGoal, number> = {
	nature_minutes: 1,
	trails: 12,
	quests: 30
};

// one garden level per weekly ring of combined outdoor time
const LEVEL_MINUTES = 120;
const MAX_LEVEL = 50;
const MIN_ELEMENTS = 3;
const MAX_ELEMENTS = 60;
const MAX_CONTRIBUTORS = 24;

// expedition ttl tracks the goal period, plus grace so a finished expedition lingers for the ui
const EXPEDITION_MIN_TTL = 60 * 60 * 24; // 1 day
const EXPEDITION_MAX_TTL = 60 * 60 * 24 * 120; // 120 days
const EXPEDITION_GRACE = 60 * 60 * 24 * 7; // 7 days

const idKey = (id: string) => `expedition:${id}`;
const ownerKey = (uid: string) => `expedition:owner:${normalizeId(uid)}`;

export function isExpeditionGoal(v: unknown): v is ExpeditionGoal {
	return typeof v === 'string' && (GOALS as string[]).includes(v);
}

function genId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(8));
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

function ttlFor(exp: Expedition): number {
	const remaining = Math.floor((Date.parse(exp.ends_at) - Date.now()) / 1000) + EXPEDITION_GRACE;
	return Math.max(EXPEDITION_MIN_TTL, Math.min(remaining, EXPEDITION_MAX_TTL));
}

function computeStatus(exp: Expedition): ExpeditionStatus {
	if (exp.progress >= exp.target) return 'complete';
	if (Date.parse(exp.ends_at) <= Date.now()) return 'expired';
	return 'active';
}

// writes both keys with the full record so owner-lookup never drifts from the id record
async function writeExpedition(env: Bindings, exp: Expedition): Promise<void> {
	const ttl = ttlFor(exp);
	const body = JSON.stringify(exp);
	await Promise.all([
		env.KV.put(idKey(exp.id), body, { expirationTtl: ttl }),
		env.KV.put(ownerKey(exp.owner_uid), body, { expirationTtl: ttl })
	]);
}

export async function getExpedition(env: Bindings, id: string): Promise<Expedition | null> {
	const raw = await env.KV.get<Expedition>(idKey(id), 'json');
	if (!raw) return null;
	return { ...raw, status: computeStatus(raw) };
}

export async function getExpeditionByOwner(
	env: Bindings,
	ownerUid: string
): Promise<Expedition | null> {
	const raw = await env.KV.get<Expedition>(ownerKey(ownerUid), 'json');
	if (!raw) return null;
	return { ...raw, status: computeStatus(raw) };
}

export type StartExpeditionInput = {
	owner_uid: string;
	title: string;
	goal: ExpeditionGoal;
	target: number;
	ends_at: string;
	members?: { uid: string; username: string }[];
};

// starts (or replaces) the owner's expedition. members seed the contributor roster at 0.
export async function startExpedition(
	env: Bindings,
	input: StartExpeditionInput
): Promise<Expedition> {
	const ownerUid = normalizeId(input.owner_uid);
	const endsMs = Date.parse(input.ends_at);
	const ends =
		Number.isFinite(endsMs) && endsMs > Date.now()
			? new Date(endsMs)
			: new Date(Date.now() + 60 * 60 * 24 * 7 * 1000);

	const roster = (input.members || [])
		.slice(0, MAX_CONTRIBUTORS)
		.map((m) => ({ uid: normalizeId(m.uid), username: m.username || 'member', contribution: 0 }));

	// the owner is always a contributor
	if (!roster.some((m) => m.uid === ownerUid)) {
		roster.unshift({
			uid: ownerUid,
			username: input.members?.find((m) => normalizeId(m.uid) === ownerUid)?.username || 'owner',
			contribution: 0
		});
	}

	const exp: Expedition = {
		id: genId(),
		owner_uid: ownerUid,
		title: (input.title || 'Circle Expedition').slice(0, 120),
		goal: isExpeditionGoal(input.goal) ? input.goal : 'nature_minutes',
		target: Math.max(1, clampInt(input.target, 1, 1_000_000, 120)),
		progress: 0,
		contributors: roster.slice(0, MAX_CONTRIBUTORS),
		status: 'active',
		starts_at: new Date().toISOString(),
		ends_at: ends.toISOString()
	};

	await writeExpedition(env, exp);
	return exp;
}

export type ContributeResult =
	| { ok: true; expedition: Expedition; justCompleted: boolean }
	| { ok: false; reason: 'not_found' | 'closed' };

// credits a member's contribution toward the shared goal (mantle2 calls this when a member
// completes an outdoor action). contribution is shown per-member, never ranked.
export async function creditContribution(
	env: Bindings,
	ownerUid: string,
	memberUid: string,
	amount: number,
	username?: string
): Promise<ContributeResult> {
	const exp = await getExpeditionByOwner(env, ownerUid);
	if (!exp) return { ok: false, reason: 'not_found' };

	const status = computeStatus(exp);
	if (status !== 'active') return { ok: false, reason: 'closed' };

	const add = clampInt(amount, 0, 1_000_000, 0);
	const uid = normalizeId(memberUid);
	const now = new Date().toISOString();

	const wasComplete = exp.progress >= exp.target;
	let contributor = exp.contributors.find((c) => c.uid === uid);
	if (!contributor) {
		if (exp.contributors.length >= MAX_CONTRIBUTORS) {
			// roster is full; still credit the shared total so the circle goal advances
			contributor = undefined;
		} else {
			contributor = { uid, username: username || 'member', contribution: 0 };
			exp.contributors.push(contributor);
		}
	}
	if (contributor) {
		contributor.contribution += add;
		contributor.last_contributed_at = now;
		if (username) contributor.username = username;
	}

	exp.progress = Math.min(exp.target, exp.progress + add);
	exp.status = computeStatus(exp);

	await writeExpedition(env, exp);

	const justCompleted = !wasComplete && exp.progress >= exp.target;
	return { ok: true, expedition: exp, justCompleted };
}

// deterministic 32-bit FNV-1a so the same input always seeds the same element
function hashString(s: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		hash ^= s.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

// weighted kind pick: common greenery, rarer creatures/stars
const KIND_TABLE: GardenElementKind[] = [
	'tree',
	'tree',
	'flower',
	'flower',
	'flower',
	'water',
	'stone',
	'stone',
	'creature',
	'star'
];

function kindForSeed(seed: number): GardenElementKind {
	return KIND_TABLE[seed % KIND_TABLE.length];
}

export function expeditionMinutes(exp: Expedition | null): number {
	if (!exp) return 0;
	return Math.round(exp.progress * (GOAL_MINUTE_WEIGHT[exp.goal] ?? 1));
}

// projects the circle's combined outdoor contribution onto a stable, growing scene.
// growth blooms element-by-element as minutes accrue, so the garden fills in over time.
export function computeGarden(
	ownerUid: string,
	exp: Expedition | null,
	options: { animated?: boolean; extraMinutes?: number } = {}
): CircleGarden {
	const owner = normalizeId(ownerUid);
	const totalMinutes = Math.max(
		0,
		expeditionMinutes(exp) + clampInt(options.extraMinutes ?? 0, 0, 10_000_000, 0)
	);
	const level = Math.min(MAX_LEVEL, Math.floor(totalMinutes / LEVEL_MINUTES));

	const contributors = (exp?.contributors || []).slice(0, MAX_CONTRIBUTORS);
	const target = Math.max(1, exp?.target ?? LEVEL_MINUTES);

	const elements: GardenElement[] = [];

	// progressive-bloom field: element i activates after i*LEVEL_MINUTES/4 minutes
	const perElement = LEVEL_MINUTES / 4; // 30 min per element
	const fieldCount = Math.min(MAX_ELEMENTS, MIN_ELEMENTS + level);
	for (let i = 0; i < fieldCount; i++) {
		const seed = hashString(`${owner}:garden:${i}`);
		const threshold = i * perElement;
		const growth = clampNumber((totalMinutes - threshold) / perElement, 0, 1, 0);
		const element: GardenElement = {
			kind: kindForSeed(seed),
			seed,
			growth
		};
		if (contributors.length) element.contributor_uid = contributors[seed % contributors.length].uid;
		elements.push(element);
	}

	// one signature element per contributor, grown by their share of the goal
	for (const c of contributors) {
		if (elements.length >= MAX_ELEMENTS) break;
		const seed = hashString(`${owner}:sig:${c.uid}`);
		elements.push({
			kind: 'tree',
			seed,
			growth: clampNumber(c.contribution / target, 0, 1, 0),
			contributor_uid: c.uid
		});
	}

	return {
		owner_uid: owner,
		level,
		total_minutes: totalMinutes,
		elements,
		animated: Boolean(options.animated),
		updated_at: new Date().toISOString()
	};
}
