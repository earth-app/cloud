import { describe, expect, it, vi } from 'vitest';
import { getMemories, MEMORY_LIMIT, yearsAgoOnSameDay } from '../../src/user/memories';
import { createMockBindings } from '../helpers/mock-bindings';
import type { Bindings } from '../../src/util/types';
import type { TrailJournalEntry } from '../../src/user/trails';

const UID = '1';
const ON = new Date(Date.UTC(2026, 7, 26, 14, 30));

function at(year: number, month: number, day: number, hour = 9): number {
	return Date.UTC(year, month, day, hour);
}

async function seedQuest(
	bindings: Bindings,
	questId: string,
	completedAt: number | null
): Promise<void> {
	const index = (await bindings.KV.get<string[]>(`user:quest_history_index:${UID}`, 'json')) ?? [];
	await bindings.KV.put(`user:quest_history_index:${UID}`, JSON.stringify([...index, questId]));
	if (completedAt !== null) {
		await bindings.KV.put(
			`user:quest_history:${UID}:${questId}`,
			JSON.stringify({ r2Key: `users/${UID}/quests/${questId}/history.bin`, completedAt })
		);
	}
}

// what `archiveCompletedQuest` writes today: pointer value plus `{ questId, completedAt }` metadata
async function seedStampedQuest(
	bindings: Bindings,
	questId: string,
	completedAt: number
): Promise<void> {
	const index = (await bindings.KV.get<string[]>(`user:quest_history_index:${UID}`, 'json')) ?? [];
	await bindings.KV.put(`user:quest_history_index:${UID}`, JSON.stringify([...index, questId]));
	await bindings.KV.put(
		`user:quest_history:${UID}:${questId}`,
		JSON.stringify({ r2Key: `users/${UID}/quests/${questId}/history.bin`, completedAt }),
		{ metadata: { questId, completedAt } }
	);
}

async function seedJournal(bindings: Bindings, entries: Partial<TrailJournalEntry>[]) {
	const full = entries.map((entry) => ({
		trailId: 'sit_spot_dawn',
		title: 'Dawn Sit Spot',
		practice: 'sit_spot',
		presenceMinutes: 15,
		reflection: { at: new Date().toISOString() },
		completedAt: new Date(at(2025, 7, 26)).toISOString(),
		...entry
	}));
	await bindings.KV.put(`trail_journal:${UID}`, JSON.stringify(full));
}

describe('yearsAgoOnSameDay', () => {
	it('counts a completion on the same month and day in an earlier year', () => {
		expect(yearsAgoOnSameDay(at(2025, 7, 26), ON)).toBe(1);
		expect(yearsAgoOnSameDay(at(2023, 7, 26), ON)).toBe(3);
	});

	it('rejects the same day this year, and anything later', () => {
		expect(yearsAgoOnSameDay(at(2026, 7, 26, 2), ON)).toBe(0);
		expect(yearsAgoOnSameDay(at(2027, 7, 26), ON)).toBe(0);
	});

	it('rejects a neighbouring day in an earlier year', () => {
		expect(yearsAgoOnSameDay(at(2025, 7, 25), ON)).toBe(0);
		expect(yearsAgoOnSameDay(at(2025, 7, 27), ON)).toBe(0);
		expect(yearsAgoOnSameDay(at(2025, 6, 26), ON)).toBe(0);
	});

	// the same instant is read in UTC on both sides, so the day boundary cannot drift per request
	it('compares in UTC, not the runtime locale', () => {
		expect(yearsAgoOnSameDay(Date.UTC(2025, 7, 26, 23, 59), ON)).toBe(1);
		expect(yearsAgoOnSameDay(Date.UTC(2025, 7, 27, 0, 1), ON)).toBe(0);
	});

	it('treats an unparseable timestamp as no memory', () => {
		expect(yearsAgoOnSameDay(Number.NaN, ON)).toBe(0);
	});

	// a leap-day completion is only ever a memory on another leap day
	it('only matches Feb 29 against Feb 29', () => {
		const leapDay = new Date(Date.UTC(2028, 1, 29));
		expect(yearsAgoOnSameDay(Date.UTC(2024, 1, 29), leapDay)).toBe(4);
		expect(yearsAgoOnSameDay(Date.UTC(2024, 1, 29), new Date(Date.UTC(2027, 2, 1)))).toBe(0);
	});
});

describe('getMemories pointer reads', () => {
	it('answers from the list pass without reading each pointer', async () => {
		const bindings = createMockBindings();
		await seedStampedQuest(bindings, 'first_light_walk', at(2025, 7, 26));
		await seedStampedQuest(bindings, 'sky_report', at(2025, 3, 2));
		const get = vi.spyOn(bindings.KV, 'get');

		const memories = await getMemories(bindings, UID, ON);

		expect(memories.map((m) => m.id)).toEqual(['first_light_walk']);
		// the index and the journal are still read; no `user:quest_history:<uid>:<questId>` is
		const pointerReads = get.mock.calls.filter(([key]) =>
			String(key).startsWith(`user:quest_history:${UID}:`)
		);
		expect(pointerReads).toEqual([]);
	});

	// the reason a metadata-only pass would have been wrong: a pointer written before
	// archiveCompletedQuest stamped metadata carries no `completedAt` in the listing
	it('falls back to a direct read for an unstamped pointer instead of dropping it', async () => {
		const bindings = createMockBindings();
		await seedQuest(bindings, 'first_light_walk', at(2024, 7, 26));
		const get = vi.spyOn(bindings.KV, 'get');

		const memories = await getMemories(bindings, UID, ON);

		expect(memories.map((m) => m.id)).toEqual(['first_light_walk']);
		expect(
			get.mock.calls.some(([key]) => String(key) === `user:quest_history:${UID}:first_light_walk`)
		).toBe(true);
	});

	it('mixes stamped and unstamped pointers in one answer', async () => {
		const bindings = createMockBindings();
		await seedStampedQuest(bindings, 'first_light_walk', at(2025, 7, 26));
		await seedQuest(bindings, 'sky_report', at(2023, 7, 26));

		const memories = await getMemories(bindings, UID, ON);

		expect(memories.map((m) => m.id)).toEqual(['first_light_walk', 'sky_report']);
		expect(memories.map((m) => m.yearsAgo)).toEqual([1, 3]);
	});

	it('pages the listing rather than stopping at the first page', async () => {
		const bindings = createMockBindings();
		const list = vi.spyOn(bindings.KV, 'list');
		await seedStampedQuest(bindings, 'first_light_walk', at(2025, 7, 26));

		await getMemories(bindings, UID, ON);

		// one page is enough here, but the call has to carry a limit for the loop to terminate
		expect(list).toHaveBeenCalledWith(
			expect.objectContaining({ prefix: `user:quest_history:${UID}:`, limit: 1000 })
		);
	});
});

describe('getMemories', () => {
	it('returns nothing for a user with no history at all', async () => {
		const bindings = createMockBindings();
		expect(await getMemories(bindings, UID, ON)).toEqual([]);
	});

	it('keeps only the completions that land on this day in an earlier year', async () => {
		const bindings = createMockBindings();
		await seedQuest(bindings, 'first_light_walk', at(2025, 7, 26));
		await seedQuest(bindings, 'say_one_thing', at(2025, 7, 25));
		await seedQuest(bindings, 'one_good_walk', at(2026, 7, 26, 1));

		const memories = await getMemories(bindings, UID, ON);
		expect(memories.map((m) => m.id)).toEqual(['first_light_walk']);
		expect(memories[0]).toMatchObject({ kind: 'quest', yearsAgo: 1, title: 'First Light' });
	});

	// the photo flag is read off the quest definition; r2 is never touched here
	it('flags a photo only when the quest has an image step', async () => {
		const bindings = createMockBindings();
		await seedQuest(bindings, 'first_light_walk', at(2024, 7, 26));
		await seedQuest(bindings, 'say_one_thing', at(2025, 7, 26));

		const memories = await getMemories(bindings, UID, ON);
		const byId = new Map(memories.map((m) => [m.id, m]));
		expect(byId.get('first_light_walk')?.photo).toBe(true);
		expect(byId.get('say_one_thing')?.photo).toBeUndefined();
	});

	it('skips a history entry with no pointer or an unknown quest id', async () => {
		const bindings = createMockBindings();
		await seedQuest(bindings, 'first_light_walk', null);
		await seedQuest(bindings, 'no_such_quest_at_all', at(2025, 7, 26));

		expect(await getMemories(bindings, UID, ON)).toEqual([]);
	});

	it('includes the trail journal with its reflection', async () => {
		const bindings = createMockBindings();
		await seedJournal(bindings, [
			{
				completedAt: new Date(at(2025, 7, 26)).toISOString(),
				reflection: { note: 'the light on the water', mood: 'calm', at: '2025-08-26T09:00:00Z' }
			},
			{ completedAt: new Date(at(2025, 7, 20)).toISOString() }
		]);

		const memories = await getMemories(bindings, UID, ON);
		expect(memories).toHaveLength(1);
		expect(memories[0]).toMatchObject({
			kind: 'trail',
			note: 'the light on the water',
			mood: 'calm',
			yearsAgo: 1
		});
	});

	it('sorts the most recent year first across both sources', async () => {
		const bindings = createMockBindings();
		await seedQuest(bindings, 'first_light_walk', at(2023, 7, 26));
		await seedJournal(bindings, [{ completedAt: new Date(at(2025, 7, 26)).toISOString() }]);

		const memories = await getMemories(bindings, UID, ON);
		expect(memories.map((m) => m.kind)).toEqual(['trail', 'quest']);
		expect(memories.map((m) => m.yearsAgo)).toEqual([1, 3]);
	});

	it('caps how much one day can hand back', async () => {
		const bindings = createMockBindings();
		await seedJournal(
			bindings,
			Array.from({ length: MEMORY_LIMIT + 4 }, (_, i) => ({
				completedAt: new Date(at(2025, 7, 26, i)).toISOString()
			}))
		);

		expect(await getMemories(bindings, UID, ON)).toHaveLength(MEMORY_LIMIT);
	});

	// the journal is rank-capped in storage; a smaller cap must not be widened by this read
	it('honours the journal cap it is given', async () => {
		const bindings = createMockBindings();
		await seedJournal(bindings, [
			{ completedAt: new Date(at(2025, 7, 26, 8)).toISOString() },
			{ completedAt: new Date(at(2025, 7, 26, 9)).toISOString() }
		]);

		expect(await getMemories(bindings, UID, ON, 1)).toHaveLength(1);
	});

	it('ignores a journal entry with a broken timestamp', async () => {
		const bindings = createMockBindings();
		await seedJournal(bindings, [{ completedAt: 'not a date' }]);

		expect(await getMemories(bindings, UID, ON)).toEqual([]);
	});
});
