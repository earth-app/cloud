import { clearCache, tryCache } from '../util/cache';
import { normalizeId } from '../util/util';

export type ImpactPointsChange = {
	reason: string;
	difference: number;
	timestamp?: number;
};

export async function getImpactPoints(
	id: string,
	kv: KVNamespace
): Promise<[number, ImpactPointsChange[]]> {
	const normalizedId = normalizeId(id);
	const key = `user:impact_points:${normalizedId}`;
	const result = await kv.getWithMetadata<{ total: number }>(key);
	let points = 0;
	let history: ImpactPointsChange[] = [];

	if (result && result.value) {
		try {
			const parsed = JSON.parse(result.value as string);
			if (Array.isArray(parsed)) {
				history = parsed as ImpactPointsChange[];
			}
		} catch (e) {
			history = [];
			console.warn(
				`Failed to parse impact points history for user ${id}, deleting and defaulting to empty history.`,
				e
			);

			// clear the invalid value to prevent future parsing issues
			await kv.delete(key);
		}
	}

	if (
		result &&
		result.metadata &&
		typeof result.metadata === 'object' &&
		result.metadata.total !== undefined
	) {
		points = Number(result.metadata.total) || 0;
	} else {
		points = history.reduce((s, h) => s + h.difference, 0);
		console.warn(
			`Impact points total for user ${id} is missing or invalid in metadata, calculated from history as ${points}. Setting total in metadata for future consistency.`
		);

		// update the KV entry to include the total in metadata for future consistency
		await kv.put(key, JSON.stringify(history), { metadata: { total: points } });
	}

	return [points, history];
}

export async function addImpactPoints(
	id: string,
	pointsToAdd: number,
	reason: string,
	kv: KVNamespace
): Promise<[number, ImpactPointsChange[]]> {
	const normalizedId = normalizeId(id);
	const key = `user:impact_points:${normalizedId}`;
	const [currentPoints, history] = await getImpactPoints(normalizedId, kv);
	const newPoints = currentPoints + pointsToAdd;
	const newHistory = [...history, { reason, difference: pointsToAdd, timestamp: Date.now() }];

	await kv.put(key, JSON.stringify(newHistory), { metadata: { total: newPoints } });
	return [newPoints, newHistory];
}

export async function removeImpactPoints(
	id: string,
	pointsToRemove: number,
	reason: string,
	kv: KVNamespace
): Promise<[number, ImpactPointsChange[]]> {
	const normalizedId = normalizeId(id);
	const key = `user:impact_points:${normalizedId}`;
	const [currentPoints, history] = await getImpactPoints(normalizedId, kv);
	const newPoints = Math.max(0, currentPoints - pointsToRemove);
	const newHistory = [...history, { reason, difference: -pointsToRemove, timestamp: Date.now() }];

	await kv.put(key, JSON.stringify(newHistory), { metadata: { total: newPoints } });
	return [newPoints, newHistory];
}

export async function setImpactPoints(
	id: string,
	points: number,
	reason: string,
	kv: KVNamespace
): Promise<[number, ImpactPointsChange[]]> {
	const points0 = Math.max(0, points);
	const normalizedId = normalizeId(id);
	const key = `user:impact_points:${normalizedId}`;

	const existing = await kv.getWithMetadata<{ total: number }>(key);
	const history =
		existing && existing.value
			? (JSON.parse(existing.value as string) as ImpactPointsChange[])
			: [];
	const oldPoints =
		existing &&
		existing.metadata &&
		typeof existing.metadata === 'object' &&
		existing.metadata.total !== undefined
			? Number(existing.metadata.total) || 0
			: history.reduce((s, h) => s + h.difference, 0);

	const difference = points0 - oldPoints;

	const newHistory = [...history, { reason, difference, timestamp: Date.now() }];
	await kv.put(key, JSON.stringify(newHistory), {
		metadata: { total: points0 }
	});

	return [points0, newHistory];
}

export const POINTS_LEADERBOARD_CACHE_KEY = 'leaderboard:points';
export const TOP_POINTS_LEADERBOARD_COUNT = 250;

// 0 = unranked/outside top, 1 = first place, etc.
export async function retrievePointsLeaderboardRank(
	id: string,
	kv: KVNamespace,
	cacheKv: KVNamespace
): Promise<number> {
	const normalizedId = normalizeId(id);
	const result = await kv.getWithMetadata<{ total: number }>(`user:impact_points:${normalizedId}`);
	const userPoints = result.metadata?.total || 0;
	if (userPoints <= 0) return 0;

	let leaderboard = await retrievePointsLeaderboard(TOP_POINTS_LEADERBOARD_COUNT, kv, cacheKv);
	let rank = leaderboard.findIndex((entry) => entry.id === normalizedId);
	if (rank >= 0) return rank + 1;

	// outside the cached top; if the user out-scores the floor, the cache is stale
	if (leaderboard.length === TOP_POINTS_LEADERBOARD_COUNT) {
		const lowestInTop = leaderboard[TOP_POINTS_LEADERBOARD_COUNT - 1].points;
		if (userPoints >= lowestInTop) {
			await clearCache(POINTS_LEADERBOARD_CACHE_KEY, cacheKv);
			leaderboard = await retrievePointsLeaderboard(TOP_POINTS_LEADERBOARD_COUNT, kv, cacheKv);
			rank = leaderboard.findIndex((entry) => entry.id === normalizedId);
			if (rank >= 0) return rank + 1;
		}
	}

	return 0;
}

// mirrors retrieveLeaderboard in journies.ts but scans impact-points totals
export async function retrievePointsLeaderboard(
	limit: number,
	kv: KVNamespace,
	cacheKv: KVNamespace
): Promise<Array<{ id: string; points: number }>> {
	return await tryCache(
		POINTS_LEADERBOARD_CACHE_KEY,
		cacheKv,
		async () => {
			const leaderboard: Array<{ id: string; points: number }> = [];
			const prefix = 'user:impact_points:';

			let page = await kv.list<{ total: number }>({ prefix, limit: 1000 });

			for (const key of page.keys) {
				const id = normalizeId(key.name.replace(prefix, ''));
				const points = key.metadata?.total || 0;
				if (points > 0) leaderboard.push({ id, points });
			}

			while (!page.list_complete && page.cursor) {
				page = await kv.list<{ total: number }>({ prefix, limit: 1000, cursor: page.cursor });

				for (const key of page.keys) {
					const id = normalizeId(key.name.replace(prefix, ''));
					const points = key.metadata?.total || 0;
					if (points > 0) leaderboard.push({ id, points });
				}
			}

			leaderboard.sort((a, b) => b.points - a.points);
			return leaderboard.slice(0, Math.min(limit, TOP_POINTS_LEADERBOARD_COUNT));
		},
		14400 // cache for 4 hours
	);
}
