import { Bindings } from '../util/types';
import { normalizeId } from '../util/util';
import { getNatureMinutesSince } from './trails';

export type PlanCueKind = 'time_place' | 'juncture';

export interface PlanCue {
	id: string;
	kind: PlanCueKind;
	text: string;
	place?: string;
}

export interface PlanResponse {
	id: string;
	text: string;
	activity_id?: string;
}

export interface PlanMenu {
	goal: string;
	cues: PlanCue[];
	responses: PlanResponse[];
}

// carries no plan text: a recorded plan is weaker than an unrecorded one (d=.31 vs .44), so the
// sentence is composed in memory, returned once, and never persisted
export interface PlanRecord {
	cue_id: string;
	response_id: string;
	cue_kind: PlanCueKind;
	formed_at: number;
	expires_at: number;
	rehearsed: boolean;
}

export interface PlanStatus {
	active: boolean;
	expires_at?: number;
	rehearsed?: boolean;
}

// one week: the strongest measured follow-up band is under a week (d=.48), and it falls to d=.19
// between one and six months, so a plan gets re-formed rather than left to decay
export const PLAN_WINDOW_DAYS = 7;
export const PLAN_MENU_SIZE = 5;
export const MAX_PLACE_LENGTH = 60;

const PLAN_TTL = 60 * 60 * 24 * 30;
// long enough to choose, short enough that a stale menu cannot be linked against
const MENU_TTL = 60 * 60;

const planKey = (id: string) => `plan:${normalizeId(id)}`;
const menuKey = (id: string) => `plan:menu:${normalizeId(id)}`;

// time-and-place cues (d=.46); a time on its own is near-null (d=.25, CI floor .002) so every
// template here has to take a real place
const TIME_PLACE_TEMPLATES = [
	'it is tomorrow morning and I pass {place}',
	'I am walking past {place} after school',
	'it is the weekend and I am near {place}',
	'I next find myself at {place}',
	'it is tomorrow evening and I am near {place}'
];

// junctures outscore time-and-place (d=.50, and d=.64 for ending a phase); they are also the only
// cue an app can observe for itself
const JUNCTURE_TEMPLATES = [
	'I finish my last class for the day',
	'I close this app',
	'I finish dinner and the table is cleared',
	'I get home and put my bag down',
	'I finish the homework I have been putting off'
];

// the THEN is always the focal behaviour (d=.46), never a preparatory step towards it (d=.30),
// and never elaborated with how or for how long (that drops it to d=.24)
const RESPONSE_TEMPLATES = [
	'stay outside for ten minutes before I go back in',
	'walk one loop around the block',
	'sit outside and watch whatever moves',
	'take the longer way home on foot',
	'step outside and find something I have not noticed before'
];

const ACTIVITY_RESPONSE = 'head outside for {activity}';

export const PLAN_GOAL = 'spend more time outside';

function sanitizePlace(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const cleaned = value
		.replace(/[\u0000-\u001f\u007f]/g, ' ')
		// drop whole tags, not just the angle brackets: stripping delimiters alone leaves the
		// inner text behind and "Elm <b>" would survive as "Elm b"
		.replace(/<[^>]*>/g, ' ')
		.replace(/[{}<>]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
	if (cleaned.length < 2) return null;
	return cleaned.slice(0, MAX_PLACE_LENGTH);
}

function pick<T>(pool: readonly T[], count: number, random: () => number): T[] {
	const copy = [...pool];
	const out: T[] = [];
	while (copy.length && out.length < count) {
		const index = Math.min(copy.length - 1, Math.floor(random() * copy.length));
		out.push(copy.splice(index, 1)[0]!);
	}
	return out;
}

export interface PlanMenuInput {
	places?: unknown;
	activities?: unknown;
	random?: () => number;
}

/* deterministic: an LLM writing the plan halves follow-through (72.8% -> 46.6%, ownership
 * mediating), while a fixed menu the user links
 * themselves raised an objectively-recorded behaviour 63% -> 76% in a field trial. The user brings
 * the goal and the linking; the app only supplies the wording.
 */
export function buildPlanMenu(input: PlanMenuInput = {}): PlanMenu {
	const random = typeof input.random === 'function' ? input.random : Math.random;

	const places = Array.isArray(input.places)
		? input.places.map(sanitizePlace).filter((place): place is string => place !== null)
		: [];

	const activities = Array.isArray(input.activities)
		? input.activities
				.map((entry) => {
					if (!entry || typeof entry !== 'object') return null;
					const record = entry as { id?: unknown; name?: unknown };
					const name = sanitizePlace(record.name);
					const id = typeof record.id === 'string' ? record.id : null;
					return name && id ? { id, name } : null;
				})
				.filter((entry): entry is { id: string; name: string } => entry !== null)
		: [];

	const cues: PlanCue[] = [];

	// interleave so the menu always offers both cue kinds even when it is trimmed
	const placeTemplates = pick(TIME_PLACE_TEMPLATES, places.length ? PLAN_MENU_SIZE : 0, random);
	const junctureTemplates = pick(JUNCTURE_TEMPLATES, PLAN_MENU_SIZE, random);

	for (let i = 0; i < PLAN_MENU_SIZE; i++) {
		const juncture = junctureTemplates[i];
		if (juncture) {
			cues.push({ id: `juncture_${i}`, kind: 'juncture', text: juncture });
		}

		const template = placeTemplates[i];
		const place = places[i % Math.max(1, places.length)];
		if (template && place) {
			cues.push({
				id: `time_place_${i}`,
				kind: 'time_place',
				text: template.replace('{place}', place),
				place
			});
		}
	}

	const responses: PlanResponse[] = pick(RESPONSE_TEMPLATES, PLAN_MENU_SIZE, random).map(
		(text, i) => ({ id: `response_${i}`, text })
	);

	// the user's own activities are their declared intention, so an activity-anchored response
	// keeps the goal theirs while the sentence stays ours
	for (const activity of pick(activities, 2, random)) {
		responses.push({
			id: `activity_${activity.id}`,
			text: ACTIVITY_RESPONSE.replace('{activity}', activity.name.toLowerCase()),
			activity_id: activity.id
		});
	}

	return { goal: PLAN_GOAL, cues: cues.slice(0, PLAN_MENU_SIZE), responses };
}

/* held server-side so a formed plan can only link options the app wrote; posting the wording back
 * would make the cue user-authored, the weakest in the taxonomy (d=.16).
 */
export async function savePlanMenu(env: Bindings, id: string, menu: PlanMenu): Promise<void> {
	await env.KV.put(menuKey(id), JSON.stringify(menu), { expirationTtl: MENU_TTL });
}

export async function readPlanMenu(env: Bindings, id: string): Promise<PlanMenu | null> {
	const raw = await env.KV.get(menuKey(id));
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as PlanMenu;
		if (!parsed || !Array.isArray(parsed.cues) || !Array.isArray(parsed.responses)) return null;
		return parsed;
	} catch {
		return null;
	}
}

export function composePlan(cue: PlanCue, response: PlanResponse): string {
	return `If ${cue.text}, then I will ${response.text}.`;
}

export async function getPlanRecord(env: Bindings, id: string): Promise<PlanRecord | null> {
	const raw = await env.KV.get(planKey(id));
	if (!raw) return null;
	try {
		return JSON.parse(raw) as PlanRecord;
	} catch {
		return null;
	}
}

export async function getPlanStatus(env: Bindings, id: string): Promise<PlanStatus> {
	const record = await getPlanRecord(env, id);
	if (!record || record.expires_at <= Date.now()) return { active: false };
	return { active: true, expires_at: record.expires_at, rehearsed: record.rehearsed };
}

export type FormPlanResult = {
	sentence: string;
	expires_at: number;
};

// rejects a second concurrent plan: one plan scores d=.41 and three collapses to d=.07
export async function formPlan(
	env: Bindings,
	id: string,
	cueId: unknown,
	responseId: unknown
): Promise<FormPlanResult> {
	const existing = await getPlanStatus(env, id);
	if (existing.active) throw new Error('A plan is already active');

	const menu = await readPlanMenu(env, id);
	if (!menu) throw new Error('No plan menu available');

	const cue = menu.cues.find((entry) => entry.id === cueId);
	const response = menu.responses.find((entry) => entry.id === responseId);
	if (!cue) throw new Error('Unknown cue');
	if (!response) throw new Error('Unknown response');

	const now = Date.now();
	const expiresAt = now + PLAN_WINDOW_DAYS * 24 * 60 * 60 * 1000;

	const record: PlanRecord = {
		cue_id: cue.id,
		response_id: response.id,
		cue_kind: cue.kind,
		formed_at: now,
		expires_at: expiresAt,
		rehearsed: false
	};

	await env.KV.put(planKey(id), JSON.stringify(record), { expirationTtl: PLAN_TTL });
	// the menu has done its job; leaving it would let the same plan be re-formed and re-read
	await env.KV.delete(menuKey(id));

	return { sentence: composePlan(cue, response), expires_at: expiresAt };
}

// one tap only; a designed rehearsal exercise added nothing in the field trial
export async function markPlanRehearsed(env: Bindings, id: string): Promise<boolean> {
	const record = await getPlanRecord(env, id);
	if (!record || record.expires_at <= Date.now()) return false;
	if (record.rehearsed) return true;

	record.rehearsed = true;
	await env.KV.put(planKey(id), JSON.stringify(record), { expirationTtl: PLAN_TTL });
	return true;
}

export type PlanOutcome = {
	formed: boolean;
	rehearsed?: boolean;
	cue_kind?: PlanCueKind;
	minutes_since_formation?: number;
	window_elapsed?: boolean;
};

export async function getPlanOutcome(env: Bindings, id: string): Promise<PlanOutcome> {
	const record = await getPlanRecord(env, id);
	if (!record) return { formed: false };

	return {
		formed: true,
		rehearsed: record.rehearsed,
		cue_kind: record.cue_kind,
		minutes_since_formation: await getNatureMinutesSince(env, id, record.formed_at),
		window_elapsed: record.expires_at <= Date.now()
	};
}
