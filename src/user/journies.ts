import { clearCache, tryCache } from '../util/cache';
import { normalizeId, isLegacyPaddedId, migrateLegacyKey, capitalizeFully } from '../util/util';
import { ExecutionCtxLike } from '../util/types';
import { addImpactPoints } from './points';

export const JOURNEY_TYPES = ['article', 'prompt', 'event'];

function getLeaderboardCacheKey(type: string) {
	return `leaderboard:${type}`;
}

function getJourneyBestKey(type: string, normalizedId: string) {
	return `journey:best:${type}:${normalizedId}`;
}

// flat bonus for beating your own record; self-approach goals track motivation about twice as
// strongly as normative ones, so the bonus is not scaled by anyone else's streak
export const PERSONAL_BEST_BONUS = 25;

// no expirationTtl on purpose: the streak key lives 48h and the record has to outlive it
export async function getJourneyBest(id: string, type: string, kv: KVNamespace): Promise<number> {
	if (!JOURNEY_TYPES.includes(type)) throw new Error('Invalid journey type');

	const raw = await kv.get(getJourneyBestKey(type, normalizeId(id)));
	if (!raw) return 0;

	const best = parseInt(raw, 10);
	return Number.isFinite(best) && best > 0 ? best : 0;
}

export async function getJourney(
	id: string,
	type: string,
	kv: KVNamespace
): Promise<[number, number]> {
	if (!JOURNEY_TYPES.includes(type)) throw new Error('Invalid journey type');

	const normalizedId = normalizeId(id);
	const key = `journey:${type}:${normalizedId}`;
	let result = await kv.getWithMetadata<{ lastWrite: number; streak: number }>(key);

	if (!result.metadata && isLegacyPaddedId(id)) {
		const legacyKey = `journey:${type}:${id}`;
		const legacyResult = await kv.getWithMetadata<{ lastWrite: number; streak: number }>(legacyKey);
		if (legacyResult.metadata) {
			await migrateLegacyKey(legacyKey, key, kv);
			result = legacyResult;
		}
	}

	if (!result.metadata) return [0, 0];

	return [result.metadata.streak || 0, result.metadata.lastWrite || 0];
}

// refreshes the 48h streak window without advancing the streak (KV replaces metadata wholesale, so streak must be rewritten)
export async function touchJourney(
	id: string,
	type: string,
	streak: number,
	kv: KVNamespace
): Promise<void> {
	if (!JOURNEY_TYPES.includes(type)) throw new Error('Invalid journey type');

	const normalizedId = normalizeId(id);
	const key = `journey:${type}:${normalizedId}`;
	await kv.put(key, streak.toString(), {
		expirationTtl: 60 * 60 * 24 * 2,
		metadata: { lastWrite: Date.now(), streak }
	});
}

export async function incrementJourney(
	id: string,
	type: string,
	kv: KVNamespace,
	ctx: ExecutionCtxLike,
	cacheKv?: KVNamespace
): Promise<number> {
	if (!JOURNEY_TYPES.includes(type)) throw new Error('Invalid journey type');

	const normalizedId = normalizeId(id);
	const key = `journey:${type}:${normalizedId}`;
	let result = await kv.getWithMetadata<{ lastWrite: number; streak: number }>(key);

	if (!result.metadata && isLegacyPaddedId(id)) {
		const legacyKey = `journey:${type}:${id}`;
		const legacyResult = await kv.getWithMetadata<{ lastWrite: number; streak: number }>(legacyKey);
		if (legacyResult.metadata) {
			await kv.delete(legacyKey);
			result = legacyResult;
		}
	}
	const currentStreak = result.metadata?.streak || 0;
	const newValue = currentStreak + 1;

	// 2 day expiration for streaks
	await kv.put(key, newValue.toString(), {
		expirationTtl: 60 * 60 * 24 * 2,
		metadata: { lastWrite: Date.now(), streak: newValue }
	});

	if (cacheKv) {
		await clearCache(getLeaderboardCacheKey(type), cacheKv);
	}

	// add impact points for the increment itself, plus a bonus for beating your own record
	ctx.waitUntil(
		(async () => {
			try {
				await addImpactPoints(normalizedId, 5, `${capitalizeFully(type)} Journey`, kv);

				const previousBest = await getJourneyBest(normalizedId, type, kv);
				if (newValue > previousBest) {
					await kv.put(getJourneyBestKey(type, normalizedId), newValue.toString());
					await addImpactPoints(
						normalizedId,
						PERSONAL_BEST_BONUS,
						`${capitalizeFully(type)} Journey Personal Best (${newValue})`,
						kv
					);
				}
			} catch (err) {
				console.error(`Failed to add impact points for journey increment for user '${id}':`, err);
			}
		})()
	);

	return newValue;
}

export const TOP_LEADERBOARD_COUNT = 250;

export async function retrieveLeaderboard(
	type: string,
	limit: number,
	kv: KVNamespace,
	cacheKv: KVNamespace
): Promise<Array<{ id: string; streak: number }>> {
	return await tryCache(
		`leaderboard:${type}`,
		cacheKv,
		async () => {
			if (!JOURNEY_TYPES.includes(type)) throw new Error('Invalid journey type');

			const leaderboard: Array<{ id: string; streak: number }> = [];
			const prefix = `journey:${type}:`;

			let page = await kv.list<{ lastWrite: number; streak: number }>({
				prefix,
				limit: 1000
			});

			for (const key of page.keys) {
				const rawId = key.name.replace(prefix, '');
				const id = normalizeId(rawId);
				const streak = key.metadata?.streak || 0;
				if (streak > 0) {
					leaderboard.push({ id, streak });
				}
			}

			while (!page.list_complete && page.cursor) {
				page = await kv.list<{ lastWrite: number; streak: number }>({
					prefix,
					limit: 1000,
					cursor: page.cursor
				});

				for (const key of page.keys) {
					const rawId = key.name.replace(prefix, '');
					const id = normalizeId(rawId);
					const streak = key.metadata?.streak || 0;
					if (streak > 0) {
						leaderboard.push({ id, streak });
					}
				}
			}

			leaderboard.sort((a, b) => b.streak - a.streak);
			return leaderboard.slice(0, Math.min(limit, TOP_LEADERBOARD_COUNT));
		},
		14400 // cache for 4 hours
	);
}

// 0 = unranked/outside top, 1 = first place, etc.
export async function retrieveLeaderboardRank(
	id: string,
	type: string,
	kv: KVNamespace,
	cacheKv: KVNamespace
): Promise<number> {
	const normalizedId = normalizeId(id);
	const [userStreak] = await getJourney(normalizedId, type, kv);
	if (userStreak === 0) return 0;

	let leaderboard = await retrieveLeaderboard(type, TOP_LEADERBOARD_COUNT, kv, cacheKv);
	let rank = leaderboard.findIndex((entry) => entry.id === normalizedId);
	if (rank >= 0) return rank + 1; // retrieve is 0-based

	// not found in top leaderboard
	if (leaderboard.length === TOP_LEADERBOARD_COUNT) {
		const lowestInTop = leaderboard[TOP_LEADERBOARD_COUNT - 1].streak;

		// cache is stale, clear it once and retry against fresh KV state
		if (userStreak >= lowestInTop) {
			await clearCache(getLeaderboardCacheKey(type), cacheKv);
			leaderboard = await retrieveLeaderboard(type, TOP_LEADERBOARD_COUNT, kv, cacheKv);
			rank = leaderboard.findIndex((entry) => entry.id === normalizedId);
			if (rank >= 0) return rank + 1;
		}
	}

	// outside top
	return 0;
}

export async function addActivityToJourney(
	id: string,
	activity: string,
	kv: KVNamespace
): Promise<void> {
	const normalizedId = normalizeId(id);
	const key = `journey:activities:${normalizedId}`;
	const activities = await kv.get(key);
	let activityList: string[] = activities ? JSON.parse(activities) : [];

	// Only add if not already present
	if (!activityList.includes(activity)) {
		activityList.push(activity);
		await kv.put(key, JSON.stringify(activityList));
	}
}

export async function getActivityJourney(id: string, kv: KVNamespace): Promise<string[]> {
	const normalizedId = normalizeId(id);
	const key = `journey:activities:${normalizedId}`;
	let value = await kv.get(key);

	if (!value && isLegacyPaddedId(id)) {
		const legacyKey = `journey:activities:${id}`;
		const legacyValue = await kv.get(legacyKey);
		if (legacyValue) {
			await migrateLegacyKey(legacyKey, key, kv);
			value = legacyValue;
		}
	}

	return value ? JSON.parse(value as string) : [];
}

export async function resetJourney(
	id: string,
	type: string,
	kv: KVNamespace,
	cacheKv?: KVNamespace
): Promise<void> {
	if (!JOURNEY_TYPES.includes(type)) throw new Error('Invalid journey type');

	const normalizedId = normalizeId(id);
	const key = `journey:${type}:${normalizedId}`;
	await kv.delete(key);

	if (cacheKv) {
		await clearCache(getLeaderboardCacheKey(type), cacheKv);
	}
}
