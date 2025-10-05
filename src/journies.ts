import { KVNamespace } from '@cloudflare/workers-types';

const journeyTypes = ['streak', 'activity', 'article', 'prompt'];

export async function getJourney(
	id: string,
	type: string,
	kv: KVNamespace
): Promise<[number, number]> {
	if (!journeyTypes.includes(type)) throw new Error('Invalid journey type');

	const key = `journey:${type}:${id}`;
	const streak = await kv.getWithMetadata<{ lastWrite: number }>(key);

	if (!streak.value) return [0, 0];
	if (!streak.metadata?.lastWrite) return [parseInt(streak.value), 0];

	return streak ? [parseInt(streak.value), streak.metadata.lastWrite] : [0, 0];
}

export async function incrementJourney(id: string, type: string, kv: KVNamespace): Promise<number> {
	if (!journeyTypes.includes(type)) throw new Error('Invalid journey type');

	const key = `journey:${type}:${id}`;
	const value = await kv.get(key);
	const newValue = value ? parseInt(value) + 1 : 1;

	// 2 day expiration for streaks
	const settings =
		type === 'streak'
			? { expirationTtl: 60 * 60 * 24 * 2, metadata: { lastWrite: Date.now() } }
			: {};

	await kv.put(key, newValue.toString(), settings);
	return newValue;
}

export async function resetJourney(id: string, type: string, kv: KVNamespace): Promise<void> {
	if (!journeyTypes.includes(type)) throw new Error('Invalid journey type');

	const key = `journey:${type}:${id}`;
	await kv.delete(key);
}
