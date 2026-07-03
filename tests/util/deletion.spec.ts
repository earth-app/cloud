import { describe, expect, it } from 'vitest';

import {
	deleteQuestHistoryEntry,
	deleteQuestHistoryDataForUser,
	deleteUserDataVariant
} from '../../src/util/deletion';
import { createMockBindings, createMockExecutionCtx } from '../helpers/mock-bindings';

async function seedCompletedQuest(
	bindings: ReturnType<typeof createMockBindings>,
	userId: string,
	questId: string,
	otherIds: string[] = []
) {
	const r2Key = `users/${userId}/quests/${questId}/history.bin`;
	await bindings.KV.put(
		`user:quest_history:${userId}:${questId}`,
		JSON.stringify({ r2Key, completedAt: Date.now() }),
		{ metadata: { questId, completedAt: Date.now() } }
	);
	await bindings.KV.put(
		`user:quest_history_index:${userId}`,
		JSON.stringify([questId, ...otherIds])
	);
	// history archive + a step binary both live under the quest's r2 folder
	await bindings.R2.put(r2Key, new Uint8Array([1, 2, 3]));
	await bindings.R2.put(`users/${userId}/quests/${questId}/step_0_0.bin`, new Uint8Array([4, 5]));
}

describe('deleteQuestHistoryEntry', () => {
	it('removes the pointer, index entry, and all r2 objects for one quest', async () => {
		const bindings = createMockBindings();
		await seedCompletedQuest(bindings, '500', 'quest_a', ['quest_b']);

		const removed = await deleteQuestHistoryEntry('500', 'quest_a', bindings);
		expect(removed).toBe(true);

		expect(await bindings.KV.get('user:quest_history:500:quest_a')).toBeNull();
		expect((bindings.R2 as any).has('users/500/quests/quest_a/history.bin')).toBe(false);
		expect((bindings.R2 as any).has('users/500/quests/quest_a/step_0_0.bin')).toBe(false);

		const index = await bindings.KV.get<string[]>('user:quest_history_index:500', 'json');
		expect(index).toEqual(['quest_b']);
	});

	it('returns false when the quest is not in history', async () => {
		const bindings = createMockBindings();
		const removed = await deleteQuestHistoryEntry('501', 'missing_quest', bindings);
		expect(removed).toBe(false);
	});

	it('deletes the index key entirely when the last quest is removed', async () => {
		const bindings = createMockBindings();
		await seedCompletedQuest(bindings, '502', 'only_quest');

		await deleteQuestHistoryEntry('502', 'only_quest', bindings);
		expect(await bindings.KV.get('user:quest_history_index:502')).toBeNull();
	});
});

describe('deleteQuestHistoryDataForUser', () => {
	it('purges every completed quest and its r2 folder', async () => {
		const bindings = createMockBindings();
		await seedCompletedQuest(bindings, '600', 'quest_a', ['quest_b']);
		await seedCompletedQuest(bindings, '600', 'quest_b', ['quest_a']);

		await deleteQuestHistoryDataForUser('600', bindings);

		expect(await bindings.KV.get('user:quest_history:600:quest_a')).toBeNull();
		expect(await bindings.KV.get('user:quest_history:600:quest_b')).toBeNull();
		expect(await bindings.KV.get('user:quest_history_index:600')).toBeNull();
		expect((bindings.R2 as any).has('users/600/quests/quest_a/history.bin')).toBe(false);
		expect((bindings.R2 as any).has('users/600/quests/quest_b/step_0_0.bin')).toBe(false);
	});
});

describe('deleteUserDataVariant', () => {
	it('purges quest history as part of full account deletion', async () => {
		const bindings = createMockBindings();
		await seedCompletedQuest(bindings, '700', 'quest_a');

		await deleteUserDataVariant('700', 700n, bindings, createMockExecutionCtx());

		expect(await bindings.KV.get('user:quest_history:700:quest_a')).toBeNull();
		expect(await bindings.KV.get('user:quest_history_index:700')).toBeNull();
		expect((bindings.R2 as any).has('users/700/quests/quest_a/history.bin')).toBe(false);
	});
});
