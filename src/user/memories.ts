import { Bindings } from '../util/types';
import { normalizeId } from '../util/util';
import { getQuest } from './quests';
import { getQuestHistory } from './quests/tracking';
import { getTrail, getTrailJournal, journalCap } from './trails';

export type MemoryKind = 'quest' | 'trail';

export interface Memory {
	kind: MemoryKind;
	id: string;
	title: string;
	icon?: string;
	completedAt: number;
	yearsAgo: number;
	// the quest definition has an image step, so the existing quest history endpoint has a photo
	// to hand back; nothing here reads r2
	photo?: boolean;
	// trail only: the private reflection kept with the journal entry
	note?: string;
	mood?: string;
}

// a calendar day only ever holds so much; the cap keeps one dashboard card from paging
export const MEMORY_LIMIT = 10;

// utc on both sides: the worker never knows the user's timezone, and a single frame is the only
// comparison stable between requests
export function yearsAgoOnSameDay(completedAt: number, onDate: Date): number {
	const then = new Date(completedAt);
	if (!Number.isFinite(then.getTime())) return 0;
	if (then.getUTCMonth() !== onDate.getUTCMonth()) return 0;
	if (then.getUTCDate() !== onDate.getUTCDate()) return 0;

	const years = onDate.getUTCFullYear() - then.getUTCFullYear();
	return years >= 1 ? years : 0;
}

function hasPhotoStep(steps: unknown): boolean {
	const flat = (Array.isArray(steps) ? steps : []).flat() as { type?: string }[];
	return flat.some((step) => {
		const type = step?.type ?? '';
		return type.startsWith('take_photo') || type === 'draw_picture';
	});
}

// one list call instead of a read per completion; pointers written before archiveCompletedQuest
// stamped metadata are absent here and the caller reads those individually
async function listCompletionStamps(env: Bindings, uid: string): Promise<Map<string, number>> {
	const stamps = new Map<string, number>();
	const prefix = `user:quest_history:${uid}:`;
	let cursor: string | undefined;

	do {
		const page = await env.KV.list<{ questId?: string; completedAt?: number }>({
			prefix,
			limit: 1000,
			...(cursor ? { cursor } : {})
		});

		for (const key of page.keys) {
			const questId = key.metadata?.questId ?? key.name.slice(prefix.length);
			const completedAt = key.metadata?.completedAt;
			if (questId && typeof completedAt === 'number') stamps.set(questId, completedAt);
		}

		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);

	return stamps;
}

async function readCompletionStamp(env: Bindings, key: string): Promise<number | undefined> {
	const pointer = await env.KV.get<{ completedAt?: number }>(key, 'json');
	return typeof pointer?.completedAt === 'number' ? pointer.completedAt : undefined;
}

/**
 * Everything a user did on this month/day in an earlier year.
 *
 * Only two sources can reach back a year: quest history (`user:quest_history:*`, no TTL, and the
 * only source carrying a photo) and the trail journal (`trail_journal:*`, no TTL but capped by
 * rank). Trailmarks (180d) and nature minutes (60d) expire long before a year, so they are not
 * read here. Nothing is written, so there is no backfill and no cron behind this.
 */
export async function getMemories(
	env: Bindings,
	uid: string,
	onDate: Date = new Date(),
	journalCapacity: number = journalCap()
): Promise<Memory[]> {
	const uid0 = normalizeId(uid);
	const [questIds, journal, stamps] = await Promise.all([
		getQuestHistory(uid0, env),
		getTrailJournal(env, uid0, journalCapacity),
		listCompletionStamps(env, uid0)
	]);

	const quests = await Promise.all(
		questIds.map(async (questId): Promise<Memory | null> => {
			// the list pass answers for every pointer written since `archiveCompletedQuest` started
			// stamping metadata; anything older is read individually rather than dropped
			const stamped = stamps.get(questId);
			const completedAt =
				stamped ?? (await readCompletionStamp(env, `user:quest_history:${uid0}:${questId}`));
			if (typeof completedAt !== 'number') return null;

			const yearsAgo = yearsAgoOnSameDay(completedAt, onDate);
			if (!yearsAgo) return null;

			// only resolved for a day that actually matched; the whole history is never enumerated
			const quest = await getQuest(questId, env, uid0);
			if (!quest) return null;

			return {
				kind: 'quest',
				id: questId,
				title: quest.title,
				icon: quest.icon,
				completedAt,
				yearsAgo,
				...(hasPhotoStep(quest.steps) ? { photo: true } : {})
			};
		})
	);

	const trails: Memory[] = [];
	for (const entry of journal) {
		const completedAt = Date.parse(entry.completedAt);
		const yearsAgo = Number.isFinite(completedAt) ? yearsAgoOnSameDay(completedAt, onDate) : 0;
		if (!yearsAgo) continue;

		trails.push({
			kind: 'trail',
			id: entry.trailId,
			title: entry.title,
			icon: getTrail(entry.trailId)?.icon,
			completedAt,
			yearsAgo,
			...(entry.reflection?.note ? { note: entry.reflection.note } : {}),
			...(entry.reflection?.mood ? { mood: entry.reflection.mood } : {})
		});
	}

	return [...quests.filter((memory): memory is Memory => memory !== null), ...trails]
		.sort((a, b) => b.completedAt - a.completedAt)
		.slice(0, MEMORY_LIMIT);
}
