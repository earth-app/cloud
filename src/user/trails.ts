import type { Bindings, ExecutionCtxLike } from '../util/types';
import { normalizeId, clampInt } from '../util/util';
import { trackAndGrant } from './badges';

// #region types

// qualitative, sustained practices — one thing, done slowly, for its own sake
export type TrailPractice =
	| 'sit_spot'
	| 'photo_series'
	| 'sound_map'
	| 'slow_look'
	| 'sky_watch'
	| 'wander'
	| 'texture'
	| 'water_sit';

export type TrailTheme = 'nature' | 'curiosity' | 'creative' | 'reflective' | 'mixed';
export type TrailRarity = 'normal' | 'rare' | 'amazing' | 'green';

// how the practice felt afterwards; self-referential, never compared to anyone
export type TrailMood = 'calm' | 'curious' | 'awed' | 'grateful' | 'refreshed' | 'unsettled';

export interface TrailPledge {
	when: string;
	where?: string;
}

export interface Trail {
	id: string;
	title: string;
	theme: TrailTheme;
	// the single sustained practice this trail invites (there are no ordered steps)
	practice: TrailPractice;
	description: string;
	icon: string;
	rarity: TrailRarity;
	// the curiosity gap shown before going out (what pulls you outside)
	curiosity: string;
	// suggested minutes of unhurried presence (a gentle target, never enforced)
	duration: number;
	// the reflective question posed on return
	reflectionPrompt: string;
	// the awe payoff revealed on completion (a fact, a piece of wonder)
	reveal: string;
	// perk: premium/seasonal trails gate on a paid rank (free users keep the core set)
	premium?: boolean;
	seasonal?: boolean;
	// cloud-authored presentation metadata, delivered embedded on every returned trail
	practiceMeta?: TrailPracticeMeta;
}

// presentation metadata for a practice (label/icon/verb/cue/defaults); authored here and
// delivered embedded on every trail so clients render without a hardcoded map
export interface TrailPracticeMeta {
	practice: TrailPractice;
	label: string; // Title Case name
	icon: string;
	// the single verb of the practice (present tense), for the presence screen
	verb: string;
	// calm one-line invitation shown while out there
	cue: string;
	// gentle default minutes if a trail does not set its own
	defaultMinutes: number;
	// whether the practice naturally involves a short series of photos
	photos: boolean;
}

// a private reflection saved to the journal after a trail practice
export interface TrailReflection {
	note?: string;
	mood?: TrailMood;
	// how many photos were taken during the practice (the photos stay on-device)
	photoCount?: number;
	// the user chose to grow their shared garden with this practice (never public)
	sharedToGarden?: boolean;
	at: string;
}

// a user's live run of a trail: unhurried presence + a private reflection (no step model)
export interface TrailRun {
	trailId: string;
	pledge?: TrailPledge;
	startedAt: string;
	// accumulated unhurried minutes of presence
	presenceMinutes: number;
	completed: boolean;
	reflection?: TrailReflection;
}

// one journal entry = a completed run, kept private to the user
export interface TrailJournalEntry {
	trailId: string;
	title: string;
	practice: TrailPractice;
	presenceMinutes: number;
	reflection: TrailReflection;
	completedAt: string;
}

export type NatureMinutesKind = 'trail' | 'quest' | 'healthkit' | 'manual';

export interface NatureMinutesSource {
	kind: NatureMinutesKind;
	ref_id?: string;
	minutes: number;
	at: string;
}

export interface NatureMinutes {
	week: string;
	minutes: number;
	target: number;
	best: number;
	sources: NatureMinutesSource[];
	updated_at: string;
}

// ~120 min/week outdoor target (self-referential ring, never compared)
export const NATURE_MINUTES_TARGET = 120;

const TRAIL_MOODS: TrailMood[] = ['calm', 'curious', 'awed', 'grateful', 'refreshed', 'unsettled'];

function isTrailMood(v: unknown): v is TrailMood {
	return typeof v === 'string' && (TRAIL_MOODS as string[]).includes(v);
}

// #endregion

// #region static catalog

// deterministic practice-based catalog: each trail is ONE unhurried practice framed by a
// curiosity gap and closed by an awe reveal. ids are opaque strings (they resolve to nothing
// but a trail — no quest projection)
export const trails: Trail[] = [
	{
		id: 'trail_sit_spot',
		title: 'The Sit Spot',
		theme: 'reflective',
		practice: 'sit_spot',
		description: 'Sit in one place long enough for the world to forget you are there.',
		icon: 'mdi:meditation',
		rarity: 'normal',
		curiosity:
			'Stay still in one spot long enough and the place resumes without you - the birds come back, the small movements start again. Almost no one waits that long.',
		duration: 12,
		reflectionPrompt: 'What returned to the place once you went quiet and still?',
		reveal:
			'Naturalists call it the sit-spot effect: after roughly ten still minutes, wildlife stops treating you as a threat and returns to normal behavior, as if you were part of the scenery.'
	},
	{
		id: 'trail_dawn_light',
		title: 'Dawn Light Series',
		theme: 'creative',
		practice: 'photo_series',
		description: 'Follow the first hour of light through a short series of frames.',
		icon: 'mdi:camera-iris',
		rarity: 'normal',
		curiosity:
			'The first hour of light after sunrise is a color that only exists then. Photographers chase it and call it golden - but you have to be outside to catch it.',
		duration: 10,
		reflectionPrompt: 'Which frame surprised you most, and what made it different?',
		reveal:
			'Low morning light travels through far more atmosphere, which scatters the blue away and leaves the warm gold that flatters everything it lands on.'
	},
	{
		id: 'trail_sound_map',
		title: 'Sound Map',
		theme: 'curiosity',
		practice: 'sound_map',
		description: 'Close your eyes and map every sound moving around you.',
		icon: 'mdi:ear-hearing',
		rarity: 'rare',
		curiosity:
			'Close your eyes outside and your world doubles in size. Sounds you filter out all day become a live map of everything moving around you.',
		duration: 8,
		reflectionPrompt: 'What was the farthest sound you could place, and the nearest?',
		reveal:
			'With your eyes shut the brain reassigns visual attention to hearing within minutes - you genuinely locate sounds more precisely in the dark.'
	},
	{
		id: 'trail_slow_look',
		title: 'Slow Look',
		theme: 'curiosity',
		practice: 'slow_look',
		description: 'Watch one living thing far longer than feels normal.',
		icon: 'mdi:magnify-scan',
		rarity: 'rare',
		curiosity:
			'Pick one living thing and watch it far longer than feels comfortable. Somewhere past the point of boredom it starts doing something you would have walked right past.',
		duration: 8,
		reflectionPrompt: 'What did it do that you would have missed at normal speed?',
		reveal:
			'Attention is trainable: studies of slow looking find people notice several times more detail once they push past the first restless minute of observation.'
	},
	{
		id: 'trail_open_sky',
		title: 'Under the Open Sky',
		theme: 'nature',
		practice: 'sky_watch',
		description: 'Lie back and give the whole sky your unhurried attention.',
		icon: 'mdi:star-shooting',
		rarity: 'amazing',
		curiosity:
			'Lie back and give the sky your whole attention. The light reaching your eyes from the faintest star left it before the first human ever looked up.',
		duration: 12,
		reflectionPrompt: 'What did the sky make you feel - small, held, curious, something else?',
		reveal:
			'Awe at a vast sky measurably slows your sense of time and makes people more generous afterwards - researchers call it the small-self effect.',
		premium: true
	},
	{
		id: 'trail_slow_wander',
		title: 'Slow Wander',
		theme: 'mixed',
		practice: 'wander',
		description: 'Walk with no destination and follow only what catches your eye.',
		icon: 'mdi:foot-print',
		rarity: 'normal',
		curiosity:
			'Walk with no destination and follow only what catches your curiosity. The route you would never have planned is the one that shows you something new.',
		duration: 15,
		reflectionPrompt: 'Where did your curiosity lead you that a map never would?',
		reveal:
			"Aimless walking activates the brain's default-mode network, the same state behind creative insight - which is why ideas tend to arrive mid-walk, not at the desk."
	},
	{
		id: 'trail_texture_hunt',
		title: 'Texture Hunt',
		theme: 'creative',
		practice: 'texture',
		description: 'Find the textures your fingers know better than your eyes.',
		icon: 'mdi:grain',
		rarity: 'rare',
		curiosity:
			'The world is covered in textures your fingers know better than your eyes. Bark, stone, moss, leaf - each one cracked or grew into its shape for a reason.',
		duration: 10,
		reflectionPrompt: 'Which texture surprised your hands the most, and why?',
		reveal:
			'Bark cracks, dried mud splits, and old paint flakes into the same patterns - all governed by one rule: a surface growing or shrinking faster than its skin can stretch.'
	},
	{
		id: 'trail_waterside',
		title: 'Waterside Hour',
		theme: 'reflective',
		practice: 'water_sit',
		description: 'Settle beside moving water as the season turns and let it hold you.',
		icon: 'mdi:waves',
		rarity: 'green',
		curiosity:
			'Settle beside moving water and simply stay. As the season turns, water changes its voice - and letting it hold your attention quietly resets something in you.',
		duration: 12,
		reflectionPrompt: 'What did the water carry away while you sat with it?',
		reveal:
			'The steady, unpredictable sound of moving water is a natural pink-noise field: it masks jarring noise and reliably lowers stress markers, which is why it feels like relief.',
		seasonal: true
	},
	{
		id: 'trail_moon_watch',
		title: 'Moon Watch',
		theme: 'nature',
		practice: 'sky_watch',
		description: 'Follow the moon for one evening and watch it move faster than you think.',
		icon: 'mdi:moon-waning-crescent',
		rarity: 'normal',
		curiosity:
			'The moon rises almost an hour later each night and changes shape on a schedule older than any calendar. Watch it once, on purpose, and it stops being wallpaper.',
		duration: 10,
		reflectionPrompt:
			'Where was the moon when you found it, and how had it moved by the time you left?',
		reveal:
			'The moon rises about 50 minutes later each day, and Earth turns it a full moon-width across the sky roughly every two minutes - fast enough to see it shift against a fixed branch if you wait.'
	},
	{
		id: 'trail_after_rain',
		title: 'After the Rain',
		theme: 'reflective',
		practice: 'water_sit',
		description: 'Go to water right after rain, when the whole land is draining into it.',
		icon: 'mdi:weather-pouring',
		rarity: 'rare',
		curiosity:
			'In the hour after rain, every stream and gutter runs louder and faster, carrying the sky back toward the sea. It is the most alive water gets, and it only lasts a while.',
		duration: 12,
		reflectionPrompt: 'What did the water sound like, and what was it carrying?',
		reveal:
			'A single inch of rain drops over 100 tons of water on one acre of ground, and within an hour most of it is moving downhill - which is why streams surge and sing right after a storm.'
	},
	{
		id: 'trail_desire_path',
		title: 'The Desire Path',
		theme: 'curiosity',
		practice: 'wander',
		description:
			'Follow the worn shortcuts people have made and see where feet vote with their steps.',
		icon: 'mdi:map-marker-distance',
		rarity: 'normal',
		curiosity:
			'Look for the dirt shortcuts worn across the grass where the paved path took the long way around. Planners call them desire paths - the map the public draws with its own feet.',
		duration: 12,
		reflectionPrompt: 'Where did the unofficial path want to go that the official one refused to?',
		reveal:
			'Some universities wait to see where desire paths form across their lawns, then pave those exact lines - letting the crowd design the walkways before a single slab is poured.'
	},
	{
		id: 'trail_skin_of_stones',
		title: 'The Skin of Stones',
		theme: 'curiosity',
		practice: 'texture',
		description:
			'Get close to the crusty patches on rock and bark and meet two lives living as one.',
		icon: 'mdi:texture-box',
		rarity: 'rare',
		curiosity:
			'The grey-green crust on old stone and bark looks like a stain, but it is alive - and it may be centuries old. Almost no one bends down far enough to notice.',
		duration: 8,
		reflectionPrompt:
			'What colors and textures did the crust hold that you never saw from standing height?',
		reveal:
			'Lichen is a fungus and an alga living as a single organism, and some arctic map lichens are among the oldest living things on Earth, growing a fraction of a millimeter a year for thousands of years.'
	},
	{
		id: 'trail_one_square_foot',
		title: 'One Square Foot',
		theme: 'nature',
		practice: 'sit_spot',
		description:
			'Claim a single square of ground and stay with it until it turns out to be crowded.',
		icon: 'mdi:vector-square',
		rarity: 'normal',
		curiosity:
			'Pick one square foot of ground and give it a whole quarter hour. What looks like empty dirt is one of the busiest neighborhoods on Earth once you slow down enough to see the traffic.',
		duration: 15,
		reflectionPrompt: 'How many living things ended up sharing your one small square?',
		reveal:
			'A single handful of healthy soil holds more microorganisms than there are people on Earth - one teaspoon can contain billions of bacteria and miles of fungal threads.'
	},
	{
		id: 'trail_loudest_quiet',
		title: 'The Loudest Quiet',
		theme: 'reflective',
		practice: 'sound_map',
		description: 'Find the quietest place you can and discover it was never quiet at all.',
		icon: 'mdi:volume-high',
		rarity: 'amazing',
		curiosity:
			'Go somewhere you think is silent, close your eyes, and wait. True silence almost does not exist outdoors - the quiet is just sound you had stopped hearing.',
		duration: 8,
		reflectionPrompt: 'What was the quietest place still telling you, once you actually listened?',
		reveal:
			'The quietest room ever measured, a padded anechoic chamber, is so silent that people begin to hear their own heartbeat and blood flow - proof the brain manufactures sound when the world stops supplying it.',
		premium: true
	},
	{
		id: 'trail_long_shadows',
		title: 'The Long Shadows',
		theme: 'creative',
		practice: 'photo_series',
		description: 'Chase the last hour of light and photograph the shadows it stretches out long.',
		icon: 'mdi:weather-sunny',
		rarity: 'rare',
		curiosity:
			'In the last hour before sunset, shadows grow longer than the things that cast them and every edge turns gold. It is the same light painters chased for centuries, and it changes by the minute.',
		duration: 10,
		reflectionPrompt: 'Which shadow surprised you by how far it reached?',
		reveal:
			'When the sun sits about ten degrees above the horizon, an object throws a shadow nearly six times its own height - which is why late light makes even a fence post look monumental.'
	},
	{
		id: 'trail_first_frost',
		title: 'First Frost',
		theme: 'nature',
		practice: 'slow_look',
		description: 'Get out on the first cold morning and study the frost before the sun erases it.',
		icon: 'mdi:snowflake',
		rarity: 'rare',
		curiosity:
			'On the first hard morning of the cold, look closely at the white edge on a leaf or window before the sun takes it. Frost draws the same feathered shapes every year, and it is gone within minutes of the light hitting it.',
		duration: 8,
		reflectionPrompt: 'What shapes did the frost make, and what did the sun do to them?',
		reveal:
			'Frost is not frozen dew - it forms when water vapor skips the liquid stage entirely and crystallizes straight onto cold surfaces, a process called deposition, which is why it grows in feathery blades instead of round droplets.',
		seasonal: true
	},
	{
		id: 'trail_leaf_fall',
		title: 'The Turning Leaves',
		theme: 'creative',
		practice: 'photo_series',
		description: 'Photograph the color coming into the leaves as the year lets go of its green.',
		icon: 'mdi:leaf-maple',
		rarity: 'amazing',
		curiosity:
			'When the leaves turn, it looks like the tree is painting itself. It is really doing the opposite - and the color you are chasing was hiding in the leaf the whole summer.',
		duration: 10,
		reflectionPrompt: 'Which color arrived first where you were, and which held out the longest?',
		reveal:
			'Autumn yellows and oranges are always present in the leaf, just masked by green chlorophyll; when the tree stops making chlorophyll for winter the hidden pigments finally show, and the reds are freshly made from trapped sugars.',
		seasonal: true
	},
	{
		id: 'trail_night_bloom',
		title: 'The Night Shift',
		theme: 'mixed',
		practice: 'sit_spot',
		description: 'Stay out past dusk beside flowers that only open once everyone has gone inside.',
		icon: 'mdi:flower-poppy',
		rarity: 'green',
		curiosity:
			'Some flowers keep the night shift - they stay shut all day and open only after dark, pumping out scent for the moths that trade pollen for a meal no one else is awake to claim.',
		duration: 15,
		reflectionPrompt: 'What opened, moved, or arrived once the light was gone?',
		reveal:
			'Night-blooming flowers such as evening primrose and moonflower can open in a matter of minutes at dusk and depend on night-flying moths; some pale, deep blooms are shaped for a single moth species with a matching tongue.',
		premium: true
	}
];

// #endregion

// #region practice metadata (source of truth; delivered embedded on every trail)

export const TRAIL_PRACTICE_META: Record<TrailPractice, TrailPracticeMeta> = {
	sit_spot: {
		practice: 'sit_spot',
		label: 'Sit Spot',
		icon: 'mdi:meditation',
		verb: 'sit',
		cue: 'Find one spot, settle in, and let the place come to you.',
		defaultMinutes: 12,
		photos: false
	},
	photo_series: {
		practice: 'photo_series',
		label: 'Photo Series',
		icon: 'mdi:camera-iris',
		verb: 'photograph',
		cue: 'Follow one thread of light, color, or shape through a few frames.',
		defaultMinutes: 10,
		photos: true
	},
	sound_map: {
		practice: 'sound_map',
		label: 'Sound Map',
		icon: 'mdi:ear-hearing',
		verb: 'listen',
		cue: 'Close your eyes and place each sound you hear around you.',
		defaultMinutes: 8,
		photos: false
	},
	slow_look: {
		practice: 'slow_look',
		label: 'Slow Look',
		icon: 'mdi:magnify-scan',
		verb: 'observe',
		cue: 'Pick one small living thing and watch it far longer than feels normal.',
		defaultMinutes: 8,
		photos: false
	},
	sky_watch: {
		practice: 'sky_watch',
		label: 'Sky Watch',
		icon: 'mdi:weather-partly-cloudy',
		verb: 'watch',
		cue: 'Lie back and give the sky your full, unhurried attention.',
		defaultMinutes: 12,
		photos: false
	},
	wander: {
		practice: 'wander',
		label: 'Slow Wander',
		icon: 'mdi:foot-print',
		verb: 'wander',
		cue: 'Walk with no destination; follow whatever catches your curiosity.',
		defaultMinutes: 15,
		photos: false
	},
	texture: {
		practice: 'texture',
		label: 'Texture Hunt',
		icon: 'mdi:hand-back-left',
		verb: 'touch',
		cue: 'Find five textures worth touching and stay with each one.',
		defaultMinutes: 10,
		photos: false
	},
	water_sit: {
		practice: 'water_sit',
		label: 'Waterside',
		icon: 'mdi:waves',
		verb: 'rest',
		cue: 'Settle beside moving water and let it hold your attention.',
		defaultMinutes: 12,
		photos: false
	}
};

// enrich a catalog trail with its authored presentation metadata (delivered embedded, like
// badges/quests) so clients need no hardcoded practice map
function withPracticeMeta(trail: Trail): Trail {
	return { ...trail, practiceMeta: TRAIL_PRACTICE_META[trail.practice] };
}

// #endregion

// #region catalog accessors

export function getAllTrails(): Trail[] {
	return trails.map(withPracticeMeta);
}

export function getTrail(id: string): Trail | null {
	const trail = trails.find((t) => t.id === id);
	return trail ? withPracticeMeta(trail) : null;
}

// perk gate: premium OR seasonal trails require a paid rank
export function isTrailLocked(trail: Trail): boolean {
	return Boolean(trail.premium || trail.seasonal);
}

// #endregion

// #region nature minutes engine

// weekly records age out; the all-time best lives in its own unttled key so it survives
const NATURE_MINUTES_WEEK_TTL = 60 * 60 * 24 * 60; // 60 days
const MAX_NATURE_SOURCES = 100;
const MAX_SINGLE_CREDIT_MINUTES = 24 * 60; // one day; clamp absurd credits

const weekKey = (uid: string, week: string) => `nature_minutes:${normalizeId(uid)}:${week}`;
const bestKey = (uid: string) => `nature_minutes:best:${normalizeId(uid)}`;

function isNatureKind(v: unknown): v is NatureMinutesKind {
	return v === 'trail' || v === 'quest' || v === 'healthkit' || v === 'manual';
}

// ISO-8601 week key, e.x. 2026-W29 (deterministic; do not compute in latent space)
export function isoWeekKey(date: Date = new Date()): string {
	const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
	// shift to the Thursday of this week (ISO weeks are Thursday-anchored)
	const dayNum = (d.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
	d.setUTCDate(d.getUTCDate() - dayNum + 3);
	const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
	const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
	firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
	const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 24 * 60 * 60 * 1000));
	return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

async function readBest(env: Bindings, uid: string): Promise<number> {
	const raw = await env.KV.get(bestKey(uid));
	const n = raw ? Number(raw) : 0;
	return Number.isFinite(n) && n > 0 ? n : 0;
}

function emptyWeek(week: string, best: number): NatureMinutes {
	return {
		week,
		minutes: 0,
		target: NATURE_MINUTES_TARGET,
		best,
		sources: [],
		updated_at: new Date().toISOString()
	};
}

export async function getNatureMinutes(
	env: Bindings,
	uid: string,
	week: string = isoWeekKey()
): Promise<NatureMinutes> {
	const [raw, best] = await Promise.all([
		env.KV.get<NatureMinutes>(weekKey(uid, week), 'json'),
		readBest(env, uid)
	]);

	if (!raw || typeof raw.minutes !== 'number') {
		return emptyWeek(week, best);
	}

	// the persistent best always wins so it survives week rollover
	return {
		week,
		minutes: Math.max(0, raw.minutes),
		target: NATURE_MINUTES_TARGET,
		best: Math.max(best, raw.best || 0, raw.minutes || 0),
		sources: Array.isArray(raw.sources) ? raw.sources : [],
		updated_at: raw.updated_at || new Date().toISOString()
	};
}

// credits minutes to the current week and rolls the all-time best forward.
// fail-safe: invalid/absurd inputs are clamped, never trusted blindly.
export async function addNatureMinutes(
	env: Bindings,
	uid: string,
	minutes: number,
	kind: NatureMinutesKind = 'manual',
	refId?: string,
	ctx?: ExecutionCtxLike
): Promise<NatureMinutes> {
	const credit = clampInt(minutes, 0, MAX_SINGLE_CREDIT_MINUTES, 0);
	const week = isoWeekKey();
	const current = await getNatureMinutes(env, uid, week);

	const source: NatureMinutesSource = {
		kind: isNatureKind(kind) ? kind : 'manual',
		minutes: credit,
		at: new Date().toISOString(),
		...(refId ? { ref_id: refId } : {})
	};

	const updated: NatureMinutes = {
		week,
		minutes: current.minutes + credit,
		target: NATURE_MINUTES_TARGET,
		best: Math.max(current.best, current.minutes + credit),
		sources: [source, ...current.sources].slice(0, MAX_NATURE_SOURCES),
		updated_at: source.at
	};

	await env.KV.put(weekKey(uid, week), JSON.stringify(updated), {
		expirationTtl: NATURE_MINUTES_WEEK_TTL
	});

	// persist the all-time best without a ttl so it outlives weekly records
	if (updated.best > current.best || (await readBest(env, uid)) < updated.best) {
		await env.KV.put(bestKey(uid), String(updated.best));
	}

	// badge hooks: full-ring (weekly target hit, deduped by week) + a new personal best
	if (credit > 0) {
		if (updated.minutes >= NATURE_MINUTES_TARGET) {
			await trackAndGrant(uid, 'nature_target_weeks', week, env, ctx);
		}
		// a strict increase over a prior best is a genuine new personal best (not the first week)
		if (current.best > 0 && updated.best > current.best) {
			await trackAndGrant(uid, 'nature_personal_bests', 1, env, ctx);
		}
	}

	return updated;
}

// sums ledger entries credited at or after `sinceMs`, scanning only the iso weeks overlapping
// [sinceMs, now] (bounded by the weekly ttl)
export async function getNatureMinutesSince(
	env: Bindings,
	uid: string,
	sinceMs: number
): Promise<number> {
	if (typeof sinceMs !== 'number' || !Number.isFinite(sinceMs)) return 0;
	const now = Date.now();
	// never look further back than the weekly ttl (those records have expired anyway)
	const start = Math.max(sinceMs, now - NATURE_MINUTES_WEEK_TTL * 1000);

	const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
	const weeks = new Set<string>();
	for (let t = start; t <= now; t += WEEK_MS) {
		weeks.add(isoWeekKey(new Date(t)));
		if (weeks.size > 12) break; // hard bound on the scan
	}
	weeks.add(isoWeekKey(new Date(now)));

	let total = 0;
	for (const week of weeks) {
		const rec = await env.KV.get<NatureMinutes>(weekKey(uid, week), 'json');
		if (!rec || !Array.isArray(rec.sources)) continue;
		for (const s of rec.sources) {
			const at = Date.parse(s.at);
			if (Number.isFinite(at) && at >= sinceMs && typeof s.minutes === 'number' && s.minutes > 0) {
				total += s.minutes;
			}
		}
	}
	return total;
}

// #endregion

// #region trail runs + private journal

const TRAIL_RUN_TTL = 60 * 60 * 24 * 7; // 7 days; a run is abandoned if never completed
const JOURNAL_CAP_FREE = 20;
const JOURNAL_CAP_PREMIUM = 100;
const MAX_PRESENCE_MINUTES = 180; // gentle clamp on a single logged practice
const MAX_NOTE_LENGTH = 1000;
const MAX_PLEDGE_LENGTH = 160;
const MAX_PHOTO_COUNT = 50;

const runKey = (uid: string, trailId: string) => `trail_run:${normalizeId(uid)}:${trailId}`;
const journalKey = (uid: string) => `trail_journal:${normalizeId(uid)}`;

// journal cap by rank; a paid rank keeps far more private history
export function journalCap(rank?: string | null): number {
	return rank && rank.toLowerCase() !== 'free' ? JOURNAL_CAP_PREMIUM : JOURNAL_CAP_FREE;
}

function sanitizePledge(pledge: unknown): TrailPledge | undefined {
	if (!pledge || typeof pledge !== 'object') return undefined;
	const p = pledge as { when?: unknown; where?: unknown };
	const when = typeof p.when === 'string' ? p.when.trim().slice(0, MAX_PLEDGE_LENGTH) : '';
	if (!when) return undefined;
	const where =
		typeof p.where === 'string' && p.where.trim()
			? p.where.trim().slice(0, MAX_PLEDGE_LENGTH)
			: undefined;
	return { when, ...(where ? { where } : {}) };
}

function sanitizeReflection(reflection: unknown): TrailReflection {
	const r = (reflection && typeof reflection === 'object' ? reflection : {}) as Record<
		string,
		unknown
	>;
	const note =
		typeof r.note === 'string' && r.note.trim()
			? r.note.trim().slice(0, MAX_NOTE_LENGTH)
			: undefined;
	const mood = isTrailMood(r.mood) ? r.mood : undefined;
	const photoCount = clampInt(r.photoCount, 0, MAX_PHOTO_COUNT, 0);
	const sharedToGarden = r.sharedToGarden === true;
	return {
		...(note ? { note } : {}),
		...(mood ? { mood } : {}),
		...(photoCount > 0 ? { photoCount } : {}),
		...(sharedToGarden ? { sharedToGarden } : {}),
		at: new Date().toISOString()
	};
}

export async function getTrailRun(
	env: Bindings,
	uid: string,
	trailId: string
): Promise<TrailRun | null> {
	return (await env.KV.get<TrailRun>(runKey(uid, trailId), 'json')) ?? null;
}

// starts (or replaces) a trail run; presence starts at 0, completion comes later
export async function startTrailRun(
	env: Bindings,
	uid: string,
	trailId: string,
	pledge?: unknown
): Promise<TrailRun> {
	const cleanPledge = sanitizePledge(pledge);
	const run: TrailRun = {
		trailId,
		startedAt: new Date().toISOString(),
		presenceMinutes: 0,
		completed: false,
		...(cleanPledge ? { pledge: cleanPledge } : {})
	};
	await env.KV.put(runKey(uid, trailId), JSON.stringify(run), { expirationTtl: TRAIL_RUN_TTL });
	return run;
}

export type CompleteTrailResult = {
	run: TrailRun;
	entry: TrailJournalEntry;
	natureMinutes: NatureMinutes;
};

// closes a run: clamps presence, pushes a private journal entry (capped by rank), credits
// nature minutes with kind 'trail'. returns null only for an unknown trail id
export async function completeTrailRun(
	env: Bindings,
	uid: string,
	trailId: string,
	presenceMinutes: number,
	reflection: unknown,
	cap: number = JOURNAL_CAP_FREE,
	ctx?: ExecutionCtxLike
): Promise<CompleteTrailResult | null> {
	const trail = getTrail(trailId);
	if (!trail) return null;

	const minutes = clampInt(presenceMinutes, 0, MAX_PRESENCE_MINUTES, 0);
	const ref = sanitizeReflection(reflection);
	const now = new Date().toISOString();

	const existing = await getTrailRun(env, uid, trailId);
	const run: TrailRun = {
		trailId,
		...(existing?.pledge ? { pledge: existing.pledge } : {}),
		startedAt: existing?.startedAt ?? now,
		presenceMinutes: minutes,
		completed: true,
		reflection: ref
	};

	const entry: TrailJournalEntry = {
		trailId,
		title: trail.title,
		practice: trail.practice,
		presenceMinutes: minutes,
		reflection: ref,
		completedAt: now
	};

	const existingJournal = (await env.KV.get<TrailJournalEntry[]>(journalKey(uid), 'json')) ?? [];
	const journal = [entry, ...(Array.isArray(existingJournal) ? existingJournal : [])].slice(
		0,
		Math.max(1, cap)
	);

	// nature minutes credit carries the badge ctx so nature-ring badges fire on this path too
	const [, , natureMinutes] = await Promise.all([
		env.KV.put(runKey(uid, trailId), JSON.stringify(run), { expirationTtl: TRAIL_RUN_TTL }),
		env.KV.put(journalKey(uid), JSON.stringify(journal)),
		addNatureMinutes(env, uid, minutes, 'trail', trailId, ctx)
	]);

	// badge hooks: total completions, distinct practice days, and a journaled reflection
	await trackAndGrant(uid, 'trails_completed', 1, env, ctx);
	await trackAndGrant(uid, 'trail_practice_days', now.slice(0, 10), env, ctx);
	if (ref.note || ref.mood) {
		await trackAndGrant(uid, 'reflections_journaled', 1, env, ctx);
	}

	return { run, entry, natureMinutes };
}

export async function getTrailJournal(
	env: Bindings,
	uid: string,
	cap: number = JOURNAL_CAP_FREE
): Promise<TrailJournalEntry[]> {
	const raw = (await env.KV.get<TrailJournalEntry[]>(journalKey(uid), 'json')) ?? [];
	return Array.isArray(raw) ? raw.slice(0, Math.max(0, cap)) : [];
}

// #endregion
