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

export function isMasteryExempt(badgeId: string): boolean {
	return MASTERY_EXEMPT_BADGE_IDS.has(badgeId);
}

// step types the AI may emit; anything outside this list is dropped during clamping.
// Mobile-only variants (distance_covered, scan_barcode) are server-wrapped with a
// non-mobile describe_text fallback alt before being returned in the final quest.
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
	'distance_covered',
	'scan_barcode'
] as const;
export type MasteryStepType = (typeof MASTERY_STEP_TYPES)[number];

const MASTERY_RARITY_TABLE: Record<Rarity, { stepCount: number; reward: number }> = {
	normal: { stepCount: 4, reward: 500 },
	rare: { stepCount: 6, reward: 1000 },
	amazing: { stepCount: 8, reward: 2000 },
	green: { stepCount: 10, reward: 4000 }
};

export type MasterySpec = {
	stepCount: number;
	reward: number;
	stepRewardCap: number;
};

export function masterySpec(rarity: Rarity): MasterySpec {
	const entry = MASTERY_RARITY_TABLE[rarity];
	return {
		stepCount: entry.stepCount,
		reward: entry.reward,
		stepRewardCap: Math.floor(entry.reward / entry.stepCount)
	};
}

const MASTERY_LABEL_DEFAULT = ['envelope', 'book_jacket', 'web_site', 'compass'];

export const MASTERY_TRACKER_LABELS: Partial<Record<BadgeTracker, string[]>> = {
	articles_read: ['book_jacket', 'envelope', 'web_site'],
	articles_read_time: ['book_jacket', 'envelope', 'web_site'],
	prompts_read: ['book_jacket', 'envelope'],
	prompts_read_time: ['book_jacket', 'envelope'],
	prompts_responded: ['fountain_pen', 'ballpoint', 'envelope'],
	prompts_created: ['fountain_pen', 'ballpoint', 'envelope'],
	article_quizzes_completed: ['book_jacket', 'envelope', 'desktop_computer'],
	article_quizzes_completed_perfect_score: ['book_jacket', 'envelope', 'desktop_computer'],
	activities_added: ['compass', 'magnetic_compass'],
	activity_read_time: ['compass', 'book_jacket'],
	impact_points_earned: ['compass', 'magnetic_compass', 'sundial'],
	events_created: ['microphone', 'theater_curtain'],
	events_attended: ['microphone', 'theater_curtain'],
	event_types_attended: ['microphone', 'theater_curtain'],
	event_images_submitted: ['reflex_camera', 'polaroid_camera', 'lens_cap'],
	event_images_submitted_good: ['reflex_camera', 'polaroid_camera'],
	event_countries_photographed: ['reflex_camera', 'polaroid_camera', 'compass'],
	friends_added: ['envelope', 'mailbag']
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

// Tier ordering across rarities. Badges that share a tracker form a tier group
// (e.g. bookworm → super_bookworm → master_bookworm → immortal_bookworm) and the
// mastery prompt uses this so higher-tier masteries are noticeably harder.
const RARITY_ORDER: Record<Rarity, number> = { normal: 0, rare: 1, amazing: 2, green: 3 };

export type BadgeTier = {
	tierIndex: number;
	totalTiers: number;
	siblings: { id: string; name: string; rarity: Rarity; description: string }[];
};

// Null when the badge has no tracker or is the only badge in its tracker group.
// Exempt badges are excluded from sibling lists so they don't distort tier counts.
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

function masteryQuestKey(userId: string, badgeId: string): string {
	return `${MASTERY_QUEST_PREFIX}:${normalizeId(userId)}:${badgeId}`;
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
	return stored?.quest ?? null;
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
	await bindings.KV.put(masteryQuestKey(userId, badge.id), JSON.stringify(stored));
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
