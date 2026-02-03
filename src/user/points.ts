import type { KVNamespace } from '@cloudflare/workers-types';
import { normalizeId, isLegacyPaddedId, migrateLegacyKey } from '../util/util';

export async function getImpactPoints(id: string, kv: KVNamespace): Promise<number> {
	const normalizedId = normalizeId(id);
	const key = `user:impact_points:${normalizedId}`;
	let points = await kv.get(key);

	// Fallback: check for legacy zero-padded key
	if (!points && isLegacyPaddedId(id)) {
		const legacyKey = `user:impact_points:${id}`;
		const legacyPoints = await kv.get(legacyKey);
		if (legacyPoints) {
			// Migrate in background
			await migrateLegacyKey(legacyKey, key, kv);
			points = legacyPoints;
		}
	}

	return points ? parseInt(points) : 0;
}

export async function addImpactPoints(
	id: string,
	pointsToAdd: number,
	kv: KVNamespace
): Promise<number> {
	const normalizedId = normalizeId(id);
	const key = `user:impact_points:${normalizedId}`;
	const currentPoints = await getImpactPoints(normalizedId, kv);
	const newPoints = currentPoints + pointsToAdd;
	await kv.put(key, newPoints.toString());
	return newPoints;
}

export async function removeImpactPoints(
	id: string,
	pointsToRemove: number,
	kv: KVNamespace
): Promise<number> {
	const normalizedId = normalizeId(id);
	const key = `user:impact_points:${normalizedId}`;
	const currentPoints = await getImpactPoints(normalizedId, kv);
	const newPoints = Math.max(0, currentPoints - pointsToRemove);
	await kv.put(key, newPoints.toString());
	return newPoints;
}

export async function setImpactPoints(id: string, points: number, kv: KVNamespace): Promise<void> {
	const normalizedId = normalizeId(id);
	const key = `user:impact_points:${normalizedId}`;
	await kv.put(key, points.toString());
}
