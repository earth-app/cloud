import { Bindings } from '../util/types';
import { normalizeId } from '../util/util';
import { getOutdoorWindow, OutdoorWindow } from '../util/weather';
import { getNatureMinutesSince } from './trails';

// decided at delivery rather than scheduled: sky's local digest is laid down days ahead and cannot
// read the state it reacts to, so it only ever nudges for today
export const OUTDOOR_ALREADY_OUT_MINUTES = 5;
export const OUTDOOR_QUIET_HOURS = 20;
export const OUTDOOR_DECAY_DAYS = 14;

export type OutdoorDecision = {
	send: boolean;
	reason:
		'send' | 'already_out_today' | 'nudged_recently' | 'no_outcome_in_a_fortnight' | 'weather';
	weather?: OutdoorWindow['reason'];
};

const sentKey = (uid: string) => `outdoor:nudged:${uid}`;

const DAY_MS = 24 * 60 * 60 * 1000;

export function decideOutdoorNudge(input: {
	minutesToday: number;
	minutesInWindow: number;
	hoursSinceNudge: number | null;
	weatherOk: boolean;
	weatherReason?: OutdoorWindow['reason'];
}): OutdoorDecision {
	// already been out: the prompt would be redundant rather than well timed
	if (input.minutesToday >= OUTDOOR_ALREADY_OUT_MINUTES) {
		return { send: false, reason: 'already_out_today' };
	}

	// one per account per day, whatever else is true
	if (input.hoursSinceNudge !== null && input.hoursSinceNudge < OUTDOOR_QUIET_HOURS) {
		return { send: false, reason: 'nudged_recently' };
	}

	// a fortnight with no credited minute means this prompt is training dismissal. it comes back the
	// moment any minutes land, and the rest of the digest keeps firing meanwhile, so this is never a
	// silent account
	if (input.minutesInWindow <= 0) {
		return { send: false, reason: 'no_outcome_in_a_fortnight' };
	}

	if (!input.weatherOk) {
		return { send: false, reason: 'weather', weather: input.weatherReason };
	}

	return { send: true, reason: 'send', weather: input.weatherReason };
}

// coordinates are optional; without them the weather gate is skipped rather than refusing
export async function shouldNudgeOutdoors(
	env: Bindings,
	uid: string,
	coords?: { lat?: number; lon?: number }
): Promise<OutdoorDecision> {
	const uid0 = normalizeId(uid);
	const now = Date.now();

	const startOfDay = now - (now % DAY_MS);
	const [minutesToday, minutesInWindow, lastNudge] = await Promise.all([
		getNatureMinutesSince(env, uid0, startOfDay),
		getNatureMinutesSince(env, uid0, now - OUTDOOR_DECAY_DAYS * DAY_MS),
		env.KV.get(sentKey(uid0))
	]);

	const lastNudgeAt = lastNudge ? Number(lastNudge) : NaN;
	const hoursSinceNudge = Number.isFinite(lastNudgeAt)
		? (now - lastNudgeAt) / (60 * 60 * 1000)
		: null;

	// only pay for a forecast once the cheap gates have passed
	const preliminary = decideOutdoorNudge({
		minutesToday,
		minutesInWindow,
		hoursSinceNudge,
		weatherOk: true
	});
	if (!preliminary.send) return preliminary;

	const hasCoords =
		typeof coords?.lat === 'number' &&
		typeof coords?.lon === 'number' &&
		Number.isFinite(coords.lat) &&
		Number.isFinite(coords.lon);
	const window = hasCoords
		? await getOutdoorWindow(env, coords!.lat!, coords!.lon!)
		: ({ ok: true, reason: 'unknown' } as OutdoorWindow);

	return decideOutdoorNudge({
		minutesToday,
		minutesInWindow,
		hoursSinceNudge,
		weatherOk: window.ok,
		weatherReason: window.reason
	});
}

export async function markOutdoorNudged(env: Bindings, uid: string): Promise<void> {
	await env.KV.put(sentKey(normalizeId(uid)), String(Date.now()), {
		expirationTtl: 60 * 60 * 48
	});
}
