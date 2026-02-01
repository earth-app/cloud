import { KVNamespace } from '@cloudflare/workers-types';
import { cache, tryCache } from './cache';

const journeyTypes = ['article', 'prompt', 'event'];

export async function getJourney(
	id: string,
	type: string,
	kv: KVNamespace
): Promise<[number, number]> {
	if (!journeyTypes.includes(type)) throw new Error('Invalid journey type');

	const key = `journey:${type}:${id}`;
	const result = await kv.getWithMetadata<{ lastWrite: number; streak: number }>(key);

	if (!result.metadata) return [0, 0];

	return [result.metadata.streak || 0, result.metadata.lastWrite || 0];
}

export async function incrementJourney(id: string, type: string, kv: KVNamespace): Promise<number> {
	if (!journeyTypes.includes(type)) throw new Error('Invalid journey type');

	const key = `journey:${type}:${id}`;
	const result = await kv.getWithMetadata<{ lastWrite: number; streak: number }>(key);
	const currentStreak = result.metadata?.streak || 0;
	const newValue = currentStreak + 1;

	// 2 day expiration for streaks
	await kv.put(key, newValue.toString(), {
		expirationTtl: 60 * 60 * 24 * 2,
		metadata: { lastWrite: Date.now(), streak: newValue }
	});

	return newValue;
}

export const TOP_LEADERBOARD_COUNT = 250;

export async function retrieveLeaderboard(
	type: string,
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
				const id = key.name.replace(prefix, '');
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
					const id = key.name.replace(prefix, '');
					const streak = key.metadata?.streak || 0;
					if (streak > 0) {
						leaderboard.push({ id, streak });
					}
				}
			}

			leaderboard.sort((a, b) => b.streak - a.streak);
			return leaderboard.slice(0, TOP_LEADERBOARD_COUNT);
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
	const [userStreak] = await getJourney(id, type, kv);
	if (userStreak === 0) return 0;

	const leaderboard = await retrieveLeaderboard(type, kv, cacheKv);
	const rank = leaderboard.findIndex((entry) => entry.id === id);
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
	const key = `journey:activities:${id}`;
	const activities = await kv.get(key);
	let activityList: string[] = activities ? JSON.parse(activities) : [];

	// Only add if not already present
	if (!activityList.includes(activity)) {
		activityList.push(activity);
		await kv.put(key, JSON.stringify(activityList));
	}
}

export async function getActivityJourney(id: string, kv: KVNamespace): Promise<string[]> {
	const key = `journey:activities:${id}`;
	return (await kv.get(key)) ? JSON.parse((await kv.get(key)) as string) : [];
}

export async function resetJourney(id: string, type: string, kv: KVNamespace): Promise<void> {
	if (!journeyTypes.includes(type)) throw new Error('Invalid journey type');

	const key = `journey:${type}:${id}`;
	await kv.delete(key);
}
