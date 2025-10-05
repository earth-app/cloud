import { KVNamespace } from '@cloudflare/workers-types';

const journeyTypes = ['article', 'prompt'];

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
	await kv.put(key, newValue.toString(), {
		expirationTtl: 60 * 60 * 24 * 2,
		metadata: { lastWrite: Date.now() }
	});
	return newValue;
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
