import { com } from '@earth-app/ocean';
import type { Quest, QuestStep } from '../quests';
import { ActivityType, Bindings, Rarity } from '../../util/types';
import { normalizeId } from '../../util/util';
import { Badge, BadgeTracker, badges } from '.';
import { generateBadgeMasterySteps } from '../../content/boat';
import type { UserProfilePromptData } from '../../util/ai';

// badges with no meaningful theme to anchor an AI-generated mastery quest
export const MASTERY_EXEMPT_BADGE_IDS: ReadonlySet<string> = new Set([
	'verified',
	'close_friends',
	'night_owl',
	'early_bird',
	'you_know_ball',
	'early_adopter',
	'old_account',
	'old_account_2',
	'journey_master',
	'ultimate_adventurer'
]);

// trackers whose badges are counterproductive to gate behind a mastery quest
export const MASTERY_EXEMPT_TRACKERS: ReadonlySet<BadgeTracker> = new Set<BadgeTracker>([
	'impact_points_earned',
	'activities_added',
	'friends_added',
	'referrals_converted',
	'quest_steps_completed',
	'quest_steps_completed_green',
	'trailmarks_thanked',
	'expeditions_contributed',
	'expeditions_completed',
	'garden_level',
	'nature_personal_bests'
]);

export function isMasteryExempt(badgeId: string): boolean {
	if (MASTERY_EXEMPT_BADGE_IDS.has(badgeId)) return true;
	const badge = badges.find((b) => b.id === badgeId);
	if (badge?.tracker_id && MASTERY_EXEMPT_TRACKERS.has(badge.tracker_id)) return true;
	return false;
}

// step types the AI may emit; anything outside this list is dropped during clamping
export const MASTERY_STEP_TYPES = [
	'draw_picture',
	'article_quiz',
	'take_photo_validation',
	'take_photo_classification',
	'transcribe_audio',
	'describe_text',
	'match_terms',
	'order_items',
	'article_read_time',
	'activity_read_time',
	'nature_minutes',
	'trailmarker_added',
	'distance_covered',
	'scan_barcode'
] as const;
export type MasteryStepType = (typeof MASTERY_STEP_TYPES)[number];

const MASTERY_RARITY_TABLE: Record<
	Rarity,
	{ stepCount: number; reward: number; minAltGroups: number; maxAltsPerGroup: number }
> = {
	normal: { stepCount: 4, reward: 500, minAltGroups: 1, maxAltsPerGroup: 3 },
	rare: { stepCount: 5, reward: 800, minAltGroups: 1, maxAltsPerGroup: 3 },
	amazing: { stepCount: 6, reward: 1500, minAltGroups: 2, maxAltsPerGroup: 4 },
	green: { stepCount: 7, reward: 2500, minAltGroups: 3, maxAltsPerGroup: 5 }
};

export type MasterySpec = {
	stepCount: number;
	reward: number;
	stepRewardCap: number;
	minAltGroups: number;
	maxAltsPerGroup: number;
};

export function masterySpec(rarity: Rarity): MasterySpec {
	const entry = MASTERY_RARITY_TABLE[rarity];
	return {
		stepCount: entry.stepCount,
		reward: entry.reward,
		stepRewardCap: Math.floor(entry.reward / entry.stepCount),
		minAltGroups: entry.minAltGroups,
		maxAltsPerGroup: entry.maxAltsPerGroup
	};
}

const MASTERY_LABEL_DEFAULT = ['envelope', 'book_jacket', 'web_site', 'magnetic_compass'];

export const MASTERY_TRACKER_LABELS: Partial<Record<BadgeTracker, string[]>> = {
	articles_read: ['book_jacket', 'envelope', 'web_site'],
	articles_read_time: ['book_jacket', 'envelope', 'web_site'],
	prompts_read: ['book_jacket', 'envelope'],
	prompts_read_time: ['book_jacket', 'envelope'],
	prompts_responded: ['fountain_pen', 'ballpoint', 'envelope'],
	prompts_created: ['fountain_pen', 'ballpoint', 'envelope'],
	article_quizzes_completed: ['book_jacket', 'envelope', 'desktop_computer'],
	article_quizzes_completed_perfect_score: ['book_jacket', 'envelope', 'desktop_computer'],
	activities_added: ['magnetic_compass'],
	activity_read_time: ['magnetic_compass', 'book_jacket'],
	impact_points_earned: ['magnetic_compass', 'sundial'],
	events_created: ['microphone', 'theater_curtain'],
	events_attended: ['microphone', 'theater_curtain'],
	event_types_attended: ['microphone', 'theater_curtain'],
	event_images_submitted: ['reflex_camera', 'polaroid_camera', 'lens_cap'],
	event_images_submitted_good: ['reflex_camera', 'polaroid_camera'],
	event_countries_photographed: ['reflex_camera', 'polaroid_camera', 'magnetic_compass'],
	friends_added: ['envelope', 'mailbag'],
	// v0.6.0 outdoor: nature/trail themed anchors for mastery-eligible trackers
	trails_completed: ['magnetic_compass', 'alp', 'lakeside'],
	reflections_journaled: ['book_jacket', 'magnetic_compass'],
	trail_practice_days: ['magnetic_compass', 'mountain_tent', 'alp'],
	nature_target_weeks: ['alp', 'lakeside', 'valley'],
	trailmarks_left: ['magnetic_compass', 'worm_fence', 'park_bench']
};

export function labelsForBadge(badge: Badge): string[] {
	if (badge.tracker_id) {
		const labels = MASTERY_TRACKER_LABELS[badge.tracker_id];
		if (labels && labels.length > 0) return labels;
	}
	return MASTERY_LABEL_DEFAULT;
}

export function activityTypeNames(): ActivityType[] {
	return com.earthapp.activity.ActivityType.values().map((t) => t.name as ActivityType);
}

const RARITY_ORDER: Record<Rarity, number> = { normal: 0, rare: 1, amazing: 2, green: 3 };

export type BadgeTier = {
	tierIndex: number;
	totalTiers: number;
	siblings: { id: string; name: string; rarity: Rarity; description: string }[];
};

export function badgeTier(badge: Badge): BadgeTier | null {
	if (!badge.tracker_id) return null;
	if (isMasteryExempt(badge.id)) return null;

	const tracker = badge.tracker_id;
	const siblings = badges
		.filter((b) => b.tracker_id === tracker && !isMasteryExempt(b.id))
		.slice()
		.sort((a, b) => {
			const ra = RARITY_ORDER[a.rarity] - RARITY_ORDER[b.rarity];
			if (ra !== 0) return ra;
			return a.id.localeCompare(b.id);
		});

	if (siblings.length <= 1) return null;

	const tierIndex = siblings.findIndex((b) => b.id === badge.id);
	if (tierIndex < 0) return null;

	return {
		tierIndex,
		totalTiers: siblings.length,
		siblings: siblings.map((b) => ({
			id: b.id,
			name: b.name,
			rarity: b.rarity,
			description: b.description
		}))
	};
}

const MASTERY_QUEST_PREFIX = 'user:badge_mastery';
const MASTERY_LOCKED_PREFIX = 'user:badge_mastery_locked';
const MASTERED_PREFIX = 'user:badge_mastered';

// stored mastery quests auto-expire from KV after 90 days; once expired the slot frees up and
// the user can generate a fresh one (no manual cleanup needed — KV TTL handles it)
export const MASTERY_TTL_SECONDS = 90 * 24 * 60 * 60;
// cap on active generated-but-not-mastered quests per user; matches the frontend disable rule
export const MASTERY_ACTIVE_CAP = 5;

function masteryQuestKey(userId: string, badgeId: string): string {
	return `${MASTERY_QUEST_PREFIX}:${normalizeId(userId)}:${badgeId}`;
}

function masteryQuestUserPrefix(userId: string): string {
	return `${MASTERY_QUEST_PREFIX}:${normalizeId(userId)}:`;
}

function masteryLockedKey(userId: string, badgeId: string): string {
	return `${MASTERY_LOCKED_PREFIX}:${normalizeId(userId)}:${badgeId}`;
}

function masteredKey(userId: string, badgeId: string): string {
	return `${MASTERED_PREFIX}:${normalizeId(userId)}:${badgeId}`;
}

export type MasteredMetadata = {
	mastered_at: number;
};

type StoredMasteryQuest = {
	quest: Quest;
	generated_at: number;
};

export async function getMasteryQuest(
	userId: string,
	badgeId: string,
	kv: KVNamespace
): Promise<Quest | null> {
	const stored = await kv.get<StoredMasteryQuest>(masteryQuestKey(userId, badgeId), 'json');
	if (!stored) return null;
	// defensive expiry check (kv ttl handles eventual deletion, but a stale read can land
	// before the ttl fires); treat anything past 90 days as already-gone
	if (Date.now() - stored.generated_at > MASTERY_TTL_SECONDS * 1000) return null;
	return stored.quest;
}

export type MasteryListItem = {
	badge_id: string;
	quest: Quest;
	generated_at: number;
	expires_at: number;
	mastered: boolean;
	mastered_at: number | null;
};

// list every stored mastery quest for the user (generated, not yet ttl-expired). includes
// mastered entries so the badge page can still render them; cap counting filters those out
export async function listMasteryQuests(
	userId: string,
	kv: KVNamespace
): Promise<MasteryListItem[]> {
	const prefix = masteryQuestUserPrefix(userId);
	const { keys } = await kv.list({ prefix });
	const items: MasteryListItem[] = [];
	for (const k of keys) {
		const badgeId = k.name.slice(prefix.length);
		if (!badgeId) continue;
		const stored = await kv.get<StoredMasteryQuest>(k.name, 'json');
		if (!stored) continue;
		if (Date.now() - stored.generated_at > MASTERY_TTL_SECONDS * 1000) continue;
		const mastered = await getMasteredMetadata(userId, badgeId, kv);
		items.push({
			badge_id: badgeId,
			quest: stored.quest,
			generated_at: stored.generated_at,
			expires_at: stored.generated_at + MASTERY_TTL_SECONDS * 1000,
			mastered: mastered !== null,
			mastered_at: mastered?.mastered_at ?? null
		});
	}
	// newest first; the badge page will render in this order
	items.sort((a, b) => b.generated_at - a.generated_at);
	return items;
}

export async function countActiveMasteryQuests(userId: string, kv: KVNamespace): Promise<number> {
	const items = await listMasteryQuests(userId, kv);
	// cap counts unmastered slots only; completing one frees the slot immediately so the user
	// can generate a new mastery without waiting for ttl
	return items.filter((i) => !i.mastered).length;
}

export async function isMasteryLocked(
	userId: string,
	badgeId: string,
	kv: KVNamespace
): Promise<boolean> {
	const v = await kv.get(masteryLockedKey(userId, badgeId));
	return v !== null;
}

export async function isBadgeMastered(
	userId: string,
	badgeId: string,
	kv: KVNamespace
): Promise<boolean> {
	const v = await kv.get(masteredKey(userId, badgeId));
	return v !== null;
}

export async function getMasteredMetadata(
	userId: string,
	badgeId: string,
	kv: KVNamespace
): Promise<MasteredMetadata | null> {
	const v = await kv.get<MasteredMetadata>(masteredKey(userId, badgeId), 'json');
	return v ?? null;
}

export async function markBadgeMastered(
	userId: string,
	badgeId: string,
	kv: KVNamespace
): Promise<void> {
	const metadata: MasteredMetadata = { mastered_at: Date.now() };
	await kv.put(masteredKey(userId, badgeId), JSON.stringify(metadata));
}

// permanently lock a mastery: deletes the stored quest so it cannot be restarted or read
export async function lockMasteryQuest(
	userId: string,
	badgeId: string,
	kv: KVNamespace
): Promise<void> {
	await kv.put(masteryLockedKey(userId, badgeId), '1');
	await kv.delete(masteryQuestKey(userId, badgeId));
}

export const MASTERY_QUEST_ID_PREFIX = 'badge_mastery_';

export function masteryQuestId(badgeId: string): string {
	return `${MASTERY_QUEST_ID_PREFIX}${badgeId}`;
}

export function masteryBadgeIdFromQuestId(questId: string): string | null {
	if (!questId.startsWith(MASTERY_QUEST_ID_PREFIX)) return null;
	const badgeId = questId.slice(MASTERY_QUEST_ID_PREFIX.length);
	return badgeId.length > 0 ? badgeId : null;
}

export function buildMasteryQuest(badge: Badge, clampedSteps: (QuestStep | QuestStep[])[]): Quest {
	const spec = masterySpec(badge.rarity);
	return {
		id: masteryQuestId(badge.id),
		title: `Badge Master: ${badge.name}`,
		description: `Complete this quest to master ${badge.name}!`,
		icon: badge.icon,
		rarity: badge.rarity,
		steps: clampedSteps,
		reward: spec.reward
	};
}

export async function generateAndStoreMasteryQuest(
	userId: string,
	badge: Badge,
	user: UserProfilePromptData,
	bindings: Bindings
): Promise<Quest> {
	const clampedSteps = await generateBadgeMasterySteps(badge, user, bindings);
	const quest = buildMasteryQuest(badge, clampedSteps);

	const stored: StoredMasteryQuest = { quest, generated_at: Date.now() };
	await bindings.KV.put(masteryQuestKey(userId, badge.id), JSON.stringify(stored), {
		expirationTtl: MASTERY_TTL_SECONDS
	});

	return quest;
}

export async function lockActiveMasteryIfApplicable(
	userId: string,
	activeQuestId: string | null | undefined,
	kv: KVNamespace
): Promise<{ locked: boolean; badgeId: string | null }> {
	if (!activeQuestId) return { locked: false, badgeId: null };
	const badgeId = masteryBadgeIdFromQuestId(activeQuestId);
	if (!badgeId) return { locked: false, badgeId: null };

	if (!badges.some((b) => b.id === badgeId)) {
		return { locked: false, badgeId: null };
	}

	await lockMasteryQuest(userId, badgeId, kv);
	return { locked: true, badgeId };
}

export function findBadge(badgeId: string): Badge | undefined {
	return badges.find((b) => b.id === badgeId);
}
