import type { KVNamespace } from '@cloudflare/workers-types';

export async function getImpactPoints(id: string, kv: KVNamespace): Promise<number> {
	const key = `user:impact_points:${id}`;
	const points = await kv.get(key);
	return points ? parseInt(points) : 0;
}

export async function addImpactPoints(
	id: string,
	pointsToAdd: number,
	kv: KVNamespace
): Promise<number> {
	const key = `user:impact_points:${id}`;
	const currentPoints = await getImpactPoints(id, kv);
	const newPoints = currentPoints + pointsToAdd;
	await kv.put(key, newPoints.toString());
	return newPoints;
}

export async function removeImpactPoints(
	id: string,
	pointsToRemove: number,
	kv: KVNamespace
): Promise<number> {
	const key = `user:impact_points:${id}`;
	const currentPoints = await getImpactPoints(id, kv);
	const newPoints = Math.max(0, currentPoints - pointsToRemove);
	await kv.put(key, newPoints.toString());
	return newPoints;
}

export async function setImpactPoints(id: string, points: number, kv: KVNamespace): Promise<void> {
	const key = `user:impact_points:${id}`;
	await kv.put(key, points.toString());
}
