import type { KVNamespace } from '@cloudflare/workers-types';
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
