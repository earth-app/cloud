import { UserProfilePromptData } from '../util/ai';
import { Bindings, ExecutionCtxLike } from '../util/types';
import { normalizeId } from '../util/util';
import { newProfilePhoto } from './profile';
import { sendUserNotification } from './notifications';

/* mantle2 sends the whole list on every mutation, so the change is diffed rather than trusted:
 * re-sending the same list must not spend a second image generation or repeat a notification.
 * absence is meaningful - a user who has never changed activities has no snapshot, and
 * their garden keeps the look it had before this feature existed.
 */
const snapshotKey = (id: string) => `user:activities:${normalizeId(id)}`;

export const MAX_SURFACED_QUESTS = 3;

export type ActivityDiff = {
	added: string[];
	removed: string[];
	next: string[];
};

export type ActivityChangeResult = {
	changed: boolean;
	added: string[];
	removed: string[];
	quests_surfaced: string[];
	photo_queued: boolean;
};

export async function getActivitySnapshot(id: string, kv: KVNamespace): Promise<string[]> {
	const raw = await kv.get(snapshotKey(id));
	if (!raw) return [];

	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
	} catch {
		return [];
	}
}

export async function setActivitySnapshot(
	id: string,
	activityIds: readonly string[],
	kv: KVNamespace
): Promise<void> {
	await kv.put(snapshotKey(id), JSON.stringify([...activityIds]));
}

/** stable fingerprint of an activity set; order-independent so a reorder is not a change */
export function activityFingerprint(activityIds: readonly string[]): string {
	const unique = [...new Set(activityIds.map((id) => id.trim().toLowerCase()).filter(Boolean))];
	if (unique.length === 0) return '';

	unique.sort();

	let hash = 0x811c9dc5;
	for (const id of unique) {
		for (let i = 0; i < id.length; i++) {
			hash ^= id.charCodeAt(i);
			hash = Math.imul(hash, 0x01000193);
		}
		hash ^= 0x2c;
		hash = Math.imul(hash, 0x01000193);
	}

	return (hash >>> 0).toString(36);
}

export function diffActivities(previous: readonly string[], next: readonly string[]): ActivityDiff {
	const clean = (ids: readonly string[]) => [
		...new Set(ids.map((id) => id.trim().toLowerCase()).filter(Boolean))
	];
	const before = new Set(clean(previous));
	const after = clean(next);
	const afterSet = new Set(after);

	return {
		added: after.filter((id) => !before.has(id)),
		removed: [...before].filter((id) => !afterSet.has(id)),
		next: after
	};
}

// `id` is the source of truth; the name fallback is for callers that build the payload by hand
export function activityIdsOf(data: UserProfilePromptData): string[] {
	return (data.activities ?? [])
		.map((activity) => {
			const withId = activity as { id?: unknown; name?: string; aliases?: string[] };
			if (typeof withId.id === 'string' && withId.id.trim()) return withId.id.trim();

			const label = (activity?.name || activity?.aliases?.find((a) => a?.trim()) || '').trim();
			return label.toLowerCase().replace(/\s+/g, '_');
		})
		.filter(Boolean);
}

function questLink(activityId: string): string {
	return `/quests/activity_quest_${activityId}`;
}

/**
 * Make an activity change do something.
 *
 * Four consequences, each independent so one failure cannot swallow the rest: the profile photo is
 * regenerated (now that the prompt actually reads activities), the quests that exist for the new
 * activities are surfaced as a notification, the snapshot is stored so the shared garden reseeds,
 * and the diff is returned for the caller to log.
 *
 * The photo runs on `ctx` rather than inline - sdxl-lightning takes 15-30s and the caller is a
 * synchronous mantle2 request.
 */
export async function applyActivityChange(
	id: string,
	data: UserProfilePromptData,
	bindings: Bindings,
	ctx: ExecutionCtxLike,
	activityIds?: readonly string[]
): Promise<ActivityChangeResult> {
	const normalizedId = normalizeId(id);
	const next = activityIds ? [...activityIds] : activityIdsOf(data);
	const previous = await getActivitySnapshot(normalizedId, bindings.KV);
	const diff = diffActivities(previous, next);

	const unchanged = diff.added.length === 0 && diff.removed.length === 0;
	if (unchanged) {
		return {
			changed: false,
			added: [],
			removed: [],
			quests_surfaced: [],
			photo_queued: false
		};
	}

	await setActivitySnapshot(normalizedId, diff.next, bindings.KV);

	const surfaced = diff.added.slice(0, MAX_SURFACED_QUESTS);
	if (surfaced.length > 0) {
		const names = surfaced.map((activityId) => activityId.replace(/_/g, ' '));
		const title = surfaced.length === 1 ? 'A Quest for Your New Interest' : 'New Quests for You';
		const description =
			surfaced.length === 1
				? `There is a quest waiting for ${names[0]}.`
				: `There are quests waiting for ${names.slice(0, -1).join(', ')} and ${names.at(-1)}.`;

		ctx.waitUntil(
			sendUserNotification(
				bindings,
				normalizedId,
				title,
				description,
				questLink(surfaced[0]!),
				'info',
				'quest'
			).catch((err) => {
				console.warn(`Failed to surface activity quests for user '${id}':`, err);
			})
		);
	}

	// only worth spending a generation when the set that conditions the image actually moved
	ctx.waitUntil(
		(async () => {
			try {
				await newProfilePhoto(data, BigInt(normalizedId), bindings, ctx);
			} catch (err) {
				console.warn(`Failed to regenerate profile photo for user '${id}':`, err);
			}
		})()
	);

	return {
		changed: true,
		added: diff.added,
		removed: diff.removed,
		quests_surfaced: surfaced.map((activityId) => `activity_quest_${activityId}`),
		photo_queued: true
	};
}
