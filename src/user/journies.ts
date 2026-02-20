import { KVNamespace } from '@cloudflare/workers-types';
import { tryCache } from '../util/cache';
import { normalizeId, isLegacyPaddedId, migrateLegacyKey, capitalizeFully } from '../util/util';
import { addImpactPoints } from './points';

const journeyTypes = ['article', 'prompt', 'event'];

export async function getJourney(
	id: string,
	type: string,
	kv: KVNamespace
): Promise<[number, number]> {
	if (!journeyTypes.includes(type)) throw new Error('Invalid journey type');

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

export async function incrementJourney(
	id: string,
	type: string,
	kv: KVNamespace,
	ctx: ExecutionContext
): Promise<number> {
	if (!journeyTypes.includes(type)) throw new Error('Invalid journey type');

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

	// add impact points for journey increment + incrementing while in top leaderboard
	ctx.waitUntil(
		(async () => {
			try {
				await addImpactPoints(normalizedId, 5, `${capitalizeFully(type)} Journey`, kv);

				const rank = await retrieveLeaderboardRank(normalizedId, type, kv, kv);
				if (rank > 0 && rank <= TOP_LEADERBOARD_COUNT) {
					// bonus points for being in the leaderboard, scaled by rank (1st gets 260, 250th gets 10)
					const bonusPoints = Math.min(260, Math.max(10, 260 - rank)); // ensure at least 10 points for being in the leaderboard
					if (bonusPoints > 0) {
						await addImpactPoints(
							normalizedId,
							bonusPoints,
							`${capitalizeFully(type)} Journey Leaderboard Bonus (Rank #${rank})`,
							kv
						);
					}
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
			if (!journeyTypes.includes(type)) throw new Error('Invalid journey type');

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

	const leaderboard = await retrieveLeaderboard(type, TOP_LEADERBOARD_COUNT, kv, cacheKv);
	const rank = leaderboard.findIndex((entry) => entry.id === normalizedId);
	if (rank >= 0) return rank + 1; // retrieve is 0-based

	// not found in top leaderboard
	if (leaderboard.length === TOP_LEADERBOARD_COUNT) {
		const lowestInTop = leaderboard[TOP_LEADERBOARD_COUNT - 1].streak;

		// cache is stale, return 0 for now
		if (userStreak >= lowestInTop) return 0;
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

export async function resetJourney(id: string, type: string, kv: KVNamespace): Promise<void> {
	if (!journeyTypes.includes(type)) throw new Error('Invalid journey type');

	const normalizedId = normalizeId(id);
	const key = `journey:${type}:${normalizedId}`;
	await kv.delete(key);
}
