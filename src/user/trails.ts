import type { ScoringCriterion } from '../content/ferry';
import type { Quest, QuestStep } from './quests';
import type { Bindings } from '../util/types';
import { normalizeId, clampInt } from '../util/util';

export type TrailTheme = 'nature' | 'curiosity' | 'creative' | 'mixed';
export type TrailRarity = 'normal' | 'rare' | 'amazing' | 'green';

export interface TrailPledge {
	when: string;
	where?: string;
}

export interface TrailStep {
	// underlying quest action reused verbatim by the quest engine
	step: QuestStep;
	// the curiosity gap shown before acting
	clue: string;
	// the awe payoff revealed on completion
	reveal: string;
}

export interface Trail {
	id: string;
	title: string;
	theme: TrailTheme;
	description: string;
	icon: string;
	rarity: TrailRarity;
	steps: TrailStep[];
	reward: number;
	// perk: premium/seasonal trails gate on paid rank
	premium?: boolean;
	seasonal?: boolean;
}

export interface TrailProgress {
	trailId: string;
	currentStep: number;
	completed: boolean;
	pledge?: TrailPledge;
	startedAt: string;
	stepRevealed: boolean[];
}

export type NatureMinutesKind = 'trail_step' | 'quest' | 'healthkit' | 'manual';

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

// trail ids double as their quest ids; getQuest resolves this prefix
export const TRAIL_QUEST_ID_PREFIX = 'trail_';

// ~120 min/week outdoor target (self-referential ring, never compared)
export const NATURE_MINUTES_TARGET = 120;

// weekly records age out; the all-time best lives in its own unttled key so it survives
const NATURE_MINUTES_WEEK_TTL = 60 * 60 * 24 * 60; // 60 days
const MAX_NATURE_SOURCES = 100;
const MAX_SINGLE_CREDIT_MINUTES = 24 * 60; // one day; clamp absurd credits

// rubric helper (weights must sum to 1.0)
function rubric(...pairs: [string, number, string][]): ScoringCriterion[] {
	return pairs.map(([id, weight, ideal]) => ({ id, weight, ideal }));
}

// deterministic trail catalog - the theme/clue/reveal layer over the quest step vocabulary.
// steps reuse existing quest step types so the quest engine validates/tracks them unchanged.
export const trails: Trail[] = [
	{
		id: 'trail_dawn_chorus',
		title: 'Dawn Chorus',
		theme: 'nature',
		description: 'Follow the first light and the birds that greet it.',
		icon: 'mdi:bird',
		rarity: 'normal',
		reward: 140,
		steps: [
			{
				clue: 'Something out there is loudest right before the sun clears the horizon. Go find where the sound is coming from.',
				reveal:
					'Birds sing at dawn because cool, still morning air carries their song up to 20x farther than midday air.',
				step: {
					type: 'take_photo_validation',
					description: 'Photograph the sky at first light.',
					parameters: ['a photo of the early morning sky around sunrise', 0.5]
				}
			},
			{
				clue: 'Walk toward the green. Count your steps and let them add up before you look at what you found.',
				reveal:
					'A brisk morning walk raises your core temperature about a degree, which is what actually wakes your brain up (not the coffee).',
				step: {
					type: 'distance_covered',
					description: 'Walk at least 400 meters outdoors.',
					parameters: [400],
					mobile_only: true
				}
			},
			{
				clue: 'Trees look still, but they are working. Frame one and hold the moment.',
				reveal:
					'A single mature tree can move over 400 liters of water into the air on a warm day, cooling the ground beneath it like a natural air conditioner.',
				step: {
					type: 'take_photo_list',
					description: 'Take a photo containing a tree or large plant.',
					parameters: [['tree', 'plant', 'leaves', 'branch'], 0.5]
				}
			}
		]
	},
	{
		id: 'trail_texture_hunt',
		title: 'Texture Hunt',
		theme: 'curiosity',
		description: 'The world is covered in patterns most people walk right past.',
		icon: 'mdi:grain',
		rarity: 'rare',
		reward: 170,
		steps: [
			{
				clue: 'Find the roughest surface within arm’s reach of where you are standing. Trust your fingers first.',
				reveal:
					'Tree bark cracks into patterns because the inside grows faster than the outer skin can stretch - the same math that cracks dry mud and old paint.',
				step: {
					type: 'take_photo_list',
					description: 'Photograph a rough natural texture (bark, stone, soil).',
					parameters: [['bark', 'rock', 'stone', 'soil', 'wood'], 0.45]
				}
			},
			{
				clue: 'Now the opposite: find something impossibly smooth. It is closer than you think.',
				reveal:
					'A water surface looks flat but is under constant tension - strong enough that some insects literally walk on it without breaking through.',
				step: {
					type: 'take_photo_list',
					description: 'Photograph a smooth surface (water, glass, a leaf).',
					parameters: [['water', 'glass', 'leaf', 'metal'], 0.45]
				}
			},
			{
				clue: 'Draw the pattern you noticed most today, from memory.',
				reveal:
					'Sketching from memory forces your brain to rebuild the image, which is why you will still remember this texture next week.',
				step: {
					type: 'draw_picture',
					description: 'Draw a natural pattern or texture you saw.',
					parameters: ['a natural texture or pattern such as bark, ripples, or leaves', 0.6]
				}
			}
		]
	},
	{
		id: 'trail_makers_eye',
		title: "Maker's Eye",
		theme: 'creative',
		description: 'Turn an ordinary walk into raw material for something you make.',
		icon: 'mdi:palette-outline',
		rarity: 'normal',
		reward: 150,
		steps: [
			{
				clue: 'Pick one color and let it lead you. Photograph the boldest example of it you can find outside.',
				reveal:
					'Your eye has far more receptors for green than any other color - a leftover from ancestors who needed to read every shade of forest.',
				step: {
					type: 'take_photo_validation',
					description: 'Photograph something outdoors with a single striking color.',
					parameters: ['a colorful object or scene found outdoors', 0.5]
				}
			},
			{
				clue: 'Describe that color to someone who has never seen it. Words only.',
				reveal:
					'Cultures that lack a word for a color genuinely struggle to distinguish it - naming a thing sharpens how clearly you can see it.',
				step: {
					type: 'describe_text',
					description: 'Describe the color and mood of what you photographed.',
					parameters: [
						rubric(
							[
								'vividness',
								0.5,
								'a vivid sensory description of a color and the feeling it evokes'
							],
							['specificity', 0.5, 'specific concrete details about the scene, light, and texture']
						),
						0.4,
						40
					]
				}
			}
		]
	},
	{
		id: 'trail_night_sky',
		title: 'Under the Night Sky',
		theme: 'nature',
		description: 'Look up after dark and meet the oldest light you will ever see.',
		icon: 'mdi:star-shooting',
		rarity: 'amazing',
		reward: 220,
		premium: true,
		steps: [
			{
				clue: 'Get away from the brightest light near you and let your eyes adjust for a few minutes. What appears?',
				reveal:
					'Your eyes take about 30 minutes to reach full night vision, and the faintest star you can see is delivering light that left it before humans built cities.',
				step: {
					type: 'take_photo_validation',
					description: 'Photograph the night sky or a dark outdoor scene.',
					parameters: ['a photo of the night sky or an outdoor scene after dark', 0.45]
				}
			},
			{
				clue: 'Name one thing you noticed in the dark that you would miss in daylight.',
				reveal:
					'In darkness your ears take over - the brain reallocates attention to sound, which is why the night feels louder than the day.',
				step: {
					type: 'describe_text',
					description: 'Describe what the night felt and sounded like.',
					parameters: [
						rubric(
							[
								'atmosphere',
								0.6,
								'a description of the quiet, the dark, and the feeling of being outside at night'
							],
							[
								'observation',
								0.4,
								'a specific detail noticed only in the dark, such as a sound or a distant light'
							]
						),
						0.4,
						30
					]
				}
			}
		]
	},
	{
		id: 'trail_first_frost',
		title: 'First Frost',
		theme: 'mixed',
		description: 'A seasonal trail for the turn toward winter.',
		icon: 'mdi:snowflake',
		rarity: 'green',
		reward: 200,
		seasonal: true,
		steps: [
			{
				clue: 'Cold changes what the world looks like. Go outside and find the first sign of it.',
				reveal:
					'Frost forms directly from water vapor skipping the liquid stage entirely - a phase change called deposition, the reverse of a cloud forming.',
				step: {
					type: 'take_photo_validation',
					description: 'Photograph a cold-weather scene outdoors.',
					parameters: ['a photo of a cold or wintry outdoor scene', 0.45]
				}
			},
			{
				clue: 'Move enough to stay warm. Let the distance stack up.',
				reveal:
					'Shivering can burn as much energy as a slow jog - your body is quietly exercising to keep its core at 37 degrees.',
				step: {
					type: 'distance_covered',
					description: 'Walk at least 500 meters in the cold.',
					parameters: [500],
					mobile_only: true
				}
			}
		]
	},
	{
		id: 'trail_small_world',
		title: 'Small World',
		theme: 'curiosity',
		description: 'Get low, look close, and meet the neighbors you never notice.',
		icon: 'mdi:magnify',
		rarity: 'rare',
		reward: 160,
		steps: [
			{
				clue: 'Somewhere near your feet, something is alive and busy. Get close enough to see it.',
				reveal:
					'A single handful of healthy soil holds more living organisms than there are people on Earth.',
				step: {
					type: 'take_photo_list',
					description: 'Photograph a small living thing (insect, flower, moss).',
					parameters: [['insect', 'flower', 'moss', 'ant', 'bee', 'leaf'], 0.4]
				}
			},
			{
				clue: 'Order these by size, smallest to largest, from what you know.',
				reveal:
					'Guessing scale trains your brain\'s "number sense", the same instinct that lets you catch a ball without doing any math.',
				step: {
					type: 'order_items',
					description: 'Order these from smallest to largest.',
					parameters: [['ant', 'bee', 'sparrow', 'squirrel', 'fox']]
				}
			}
		]
	},
	{
		id: 'trail_water_way',
		title: 'The Water Way',
		theme: 'nature',
		description: 'Follow water wherever you can find it and learn where it is going.',
		icon: 'mdi:water',
		rarity: 'normal',
		reward: 150,
		steps: [
			{
				clue: 'Find water in any form - a puddle, a stream, a fountain, the sea. Frame it.',
				reveal:
					'Every drop of water you find has been on Earth for billions of years, endlessly recycled - the water in that puddle may have once been inside a dinosaur.',
				step: {
					type: 'take_photo_list',
					description: 'Photograph water in any form.',
					parameters: [['water', 'river', 'lake', 'puddle', 'fountain', 'ocean'], 0.45]
				}
			},
			{
				clue: 'Where is that water heading next? Write your best guess.',
				reveal:
					'Nearly all water flows, eventually, to the sea - and the path it takes is called a watershed, the invisible shape of the land around you.',
				step: {
					type: 'describe_text',
					description: 'Describe where this water came from and where it is going.',
					parameters: [
						rubric(
							['reasoning', 0.6, 'a thoughtful guess about where the water flows and why'],
							['observation', 0.4, 'specific detail about the water and its surroundings']
						),
						0.4,
						30
					]
				}
			}
		]
	}
];

export function getAllTrails(): Trail[] {
	return trails;
}

export function getTrail(id: string): Trail | null {
	return trails.find((t) => t.id === id) ?? null;
}

// perk gate: premium OR seasonal trails require a paid rank
export function isTrailLocked(trail: Trail): boolean {
	return Boolean(trail.premium || trail.seasonal);
}

// projects a trail onto the Quest shape so the quest engine tracks/validates it unchanged.
// the trail id is the quest id; premium mirrors the existing premium-quest gate.
export function trailToQuest(trail: Trail): Quest {
	const permissions = new Set<'location' | 'camera' | 'record' | 'motion'>();
	for (const s of trail.steps) {
		const t = s.step.type;
		if (t.startsWith('take_photo') || t === 'draw_picture') permissions.add('camera');
		if (t === 'take_photo_location') permissions.add('location');
		if (t === 'distance_covered') permissions.add('motion');
		if (t === 'transcribe_audio') permissions.add('record');
	}

	return {
		id: trail.id,
		title: trail.title,
		description: trail.description,
		icon: trail.icon,
		rarity: trail.rarity,
		steps: trail.steps.map((s) => s.step),
		reward: trail.reward,
		premium: isTrailLocked(trail),
		...(permissions.size ? { permissions: [...permissions] } : {})
	};
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

const weekKey = (uid: string, week: string) => `nature_minutes:${normalizeId(uid)}:${week}`;
const bestKey = (uid: string) => `nature_minutes:best:${normalizeId(uid)}`;

function isNatureKind(v: unknown): v is NatureMinutesKind {
	return v === 'trail_step' || v === 'quest' || v === 'healthkit' || v === 'manual';
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
	refId?: string
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

	return updated;
}
