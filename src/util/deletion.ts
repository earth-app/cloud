import { badges, resetBadgeProgress, revokeBadge } from '../user/badges';
import { JOURNEY_TYPES, resetJourney } from '../user/journies';
import { getCustomQuestsByOwner, deleteCustomQuest } from '../user/quests/custom';
import { resetQuestProgress } from '../user/quests/tracking';
import { deleteEventImageSubmissions } from '../user/submissions';
import { clearCachePrefix } from './cache';
import { Bindings, ExecutionCtxLike } from './types';
import { batchProcess } from './util';
import { normalizeId } from './util';

const DELETE_BATCH_SIZE = 200;

async function listAllKvKeysByPrefix(kv: KVNamespace, prefix: string): Promise<string[]> {
	const keys: string[] = [];
	let cursor: string | undefined;

	while (true) {
		const page = await kv.list({ prefix, cursor, limit: 1000 });
		for (const key of page.keys) {
			keys.push(key.name);
		}

		if (page.list_complete || !page.cursor) {
			break;
		}

		cursor = page.cursor;
	}

	return keys;
}

export async function deleteKvKeys(kv: KVNamespace, keys: string[]): Promise<void> {
	if (keys.length === 0) {
		return;
	}

	await batchProcess(
		keys.map((key) => kv.delete(key)),
		DELETE_BATCH_SIZE
	);
}

export async function deleteKvPrefix(kv: KVNamespace, prefix: string): Promise<void> {
	const keys = await listAllKvKeysByPrefix(kv, prefix);
	await deleteKvKeys(kv, keys);
}

export async function deleteR2Prefix(r2: R2Bucket, prefix: string): Promise<void> {
	let cursor: string | undefined;
	const keys: string[] = [];

	while (true) {
		const page = await r2.list({ prefix, cursor, limit: 1000 });
		for (const object of page.objects) {
			keys.push(object.key);
		}

		if (page.truncated !== true || !page.cursor) {
			break;
		}

		cursor = page.cursor;
	}

	if (keys.length === 0) {
		return;
	}

	await batchProcess(
		keys.map((key) => r2.delete(key)),
		DELETE_BATCH_SIZE
	);
}

async function deleteDurableObjectState(stub: DurableObjectStub): Promise<void> {
	try {
		await stub.fetch('https://do/delete', { method: 'DELETE' });
	} catch (err) {
		console.error('Failed to purge durable object state:', err);
	}
}

export async function deleteUserDurableObjectState(userId: string, env: Bindings): Promise<void> {
	const variants = Array.from(new Set([normalizeId(userId), userId].filter(Boolean)));

	await Promise.all(
		variants.flatMap((variant) => [
			deleteDurableObjectState(env.TIMER.get(env.TIMER.idFromName(variant))),
			deleteDurableObjectState(env.NOTIFIER.get(env.NOTIFIER.idFromName(`users:${variant}`)))
		])
	);
}

async function deleteQuestHistoryDataForUser(userId: string, env: Bindings): Promise<void> {
	const historyPrefix = `user:quest_history:${userId}:`;
	const historyKeys = await listAllKvKeysByPrefix(env.KV, historyPrefix);

	const r2Keys = await Promise.all(
		historyKeys.map(async (key) => {
			const record = await env.KV.get<{ r2Key?: string }>(key, 'json');
			return record?.r2Key || null;
		})
	);

	await batchProcess(
		r2Keys
			.filter((value): value is string => typeof value === 'string' && value.length > 0)
			.map((key) => env.R2.delete(key)),
		DELETE_BATCH_SIZE
	);

	await Promise.all([
		deleteKvKeys(env.KV, historyKeys),
		env.KV.delete(`user:quest_history_index:${userId}`),
		clearCachePrefix(`cache:quest_history:${userId}:`, env.CACHE)
	]);
}

export async function deleteUserDataVariant(
	userId: string,
	numericUserId: bigint,
	env: Bindings,
	executionCtx: ExecutionCtxLike
): Promise<void> {
	for (const badge of badges) {
		if (badge.tracker_id) {
			await resetBadgeProgress(userId, badge.id, env.KV);
		} else {
			await revokeBadge(userId, badge.id, env.KV);
		}
	}

	await Promise.all([
		// Explicit prefix sweeps catch dangling badge keys and unknown trackers.
		deleteKvPrefix(env.KV, `user:badge:${userId}:`),
		deleteKvPrefix(env.KV, `user:badge_tracker:${userId}:`),
		deleteKvPrefix(env.KV, `article:quiz_score:${userId}:`),
		env.KV.delete(`journey:activities:${userId}`),
		env.KV.delete(`user:impact_points:${userId}`),
		deleteQuestHistoryDataForUser(userId, env),
		clearCachePrefix(`user:profile_photo:${userId}:`, env.CACHE),
		clearCachePrefix(`user:${userId}:submissions`, env.CACHE),
		clearCachePrefix(`user:${userId}:submissions:`, env.CACHE)
	]);

	await deleteUserDurableObjectState(userId, env);

	await Promise.allSettled(
		JOURNEY_TYPES.map(async (type) => {
			await resetJourney(userId, type, env.KV, env.CACHE);
		})
	);

	await resetQuestProgress(userId, env);
	await deleteEventImageSubmissions(null, numericUserId, env, executionCtx);

	const customQuests = await getCustomQuestsByOwner(userId, env.KV);
	await Promise.all(customQuests.map((quest) => deleteCustomQuest(quest.id, env.KV)));
}
