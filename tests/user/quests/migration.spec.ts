import { beforeEach, describe, expect, it } from 'vitest';
import type { Quest, QuestStep } from '../../../src/user/quests';
import {
	hashQuestSteps,
	hashStepSlot,
	invalidateQuestHashCache,
	migrateProgress
} from '../../../src/user/quests/migration';
import type { QuestStepProgressEntry } from '../../../src/user/quests/tracking';

// every test mints fresh hashes; the module-level cache otherwise leaks across tests
// because they reuse the same quest id.
beforeEach(() => {
	invalidateQuestHashCache('q');
});

// minimal Quest factory — only fields migrateProgress reads
function makeQuest(id: string, steps: (QuestStep | QuestStep[])[]): Quest {
	return {
		id,
		title: id,
		description: '',
		icon: 'mdi:test',
		rarity: 'normal',
		steps,
		reward: 0
	} as Quest;
}

// loose typing here is intentional — these are synthetic shapes that only need to round-trip
// through hashing and migration. the real classification-label union is too narrow to mock.
const step = (overrides: Record<string, unknown> = {}): QuestStep => {
	const base = {
		type: 'take_photo_classification',
		description: 'photo',
		parameters: ['cat', 0.7]
	};
	return { ...base, ...overrides } as unknown as QuestStep;
};

describe('hash helpers', () => {
	it('produces a stable hash regardless of key order', () => {
		const a = {
			type: 'take_photo_classification',
			description: 'A',
			parameters: ['cat', 0.7]
		} as unknown as QuestStep;
		const b = {
			parameters: ['cat', 0.7],
			description: 'A',
			type: 'take_photo_classification'
		} as unknown as QuestStep;
		expect(hashStepSlot(a)).toBe(hashStepSlot(b));
	});

	it('returns different hashes for different parameters', () => {
		const a = step({ parameters: ['cat', 0.7] });
		const b = step({ parameters: ['cat', 0.8] });
		expect(hashStepSlot(a)).not.toBe(hashStepSlot(b));
	});

	it('returns different hashes for different step types', () => {
		const a = step({ type: 'take_photo_classification', parameters: ['cat', 0.7] });
		const b = step({ type: 'draw_picture', parameters: ['cat', 0.7] });
		expect(hashStepSlot(a)).not.toBe(hashStepSlot(b));
	});

	it('hashes alt groups distinctly from singles', () => {
		const single = step({ parameters: ['cat', 0.7] });
		const alt = [single];
		expect(hashStepSlot(alt)).not.toBe(hashStepSlot(single));
	});
});

describe('migrateProgress — no-op cases', () => {
	it('returns unchanged when hashes match', () => {
		const quest = makeQuest('q', [step({ parameters: ['a', 0.7] })]);
		const hashes = hashQuestSteps(quest.steps);
		const progress: QuestStepProgressEntry[] = [
			{
				type: 'take_photo_classification',
				index: 0,
				submittedAt: 100,
				r2Key: 'r2key'
			} as QuestStepProgressEntry
		];
		const out = migrateProgress(quest, hashes, progress, 1);
		expect(out.changed).toBe(false);
		expect(out.progress).toBe(progress);
		expect(out.migrations).toHaveLength(0);
		expect(out.staleR2Keys).toHaveLength(0);
	});

	it('backfills hashes without claiming migration when none were stored', () => {
		const quest = makeQuest('q', [step({ parameters: ['a', 0.7] })]);
		const out = migrateProgress(quest, undefined, [], 0);
		expect(out.changed).toBe(false);
		expect(out.newHashes).toHaveLength(1);
	});
});

describe('migrateProgress — single-step changes', () => {
	it('replaces an entry whose type changed with a migration stub and queues r2 cleanup', () => {
		const oldQuest = makeQuest('q', [
			step({ type: 'take_photo_classification', parameters: ['a', 0.7] })
		]);
		const oldHashes = hashQuestSteps(oldQuest.steps);
		const newQuest = makeQuest('q', [step({ type: 'describe_text', parameters: [[], 0.6] })]);
		const progress: QuestStepProgressEntry[] = [
			{
				type: 'take_photo_classification',
				index: 0,
				submittedAt: 100,
				r2Key: 'r2/orphaned.bin'
			} as QuestStepProgressEntry
		];
		const out = migrateProgress(newQuest, oldHashes, progress, 1, 500);
		expect(out.changed).toBe(true);
		expect(out.migrations).toEqual([
			{ stepIndex: 0, from: 'take_photo_classification', reason: 'type_changed' }
		]);
		expect(out.staleR2Keys).toContain('r2/orphaned.bin');

		const migrated = out.progress[0] as QuestStepProgressEntry & {
			migrated: { from: string; reason: string };
		};
		expect(migrated.type).toBe('describe_text');
		expect(migrated.submittedAt).toBe(100); // preserved
		expect(migrated.migrated.from).toBe('take_photo_classification');
		expect(migrated.migrated.reason).toBe('type_changed');
		// submission fields must NOT be carried over
		expect((migrated as { r2Key?: string }).r2Key).toBeUndefined();
	});

	it('detects params_changed when only parameters differ', () => {
		const oldQuest = makeQuest('q', [step({ parameters: ['cat', 0.7] })]);
		const oldHashes = hashQuestSteps(oldQuest.steps);
		const newQuest = makeQuest('q', [step({ parameters: ['cat', 0.85] })]);
		const progress: QuestStepProgressEntry[] = [
			{
				type: 'take_photo_classification',
				index: 0,
				submittedAt: 100,
				r2Key: 'r'
			} as QuestStepProgressEntry
		];
		const out = migrateProgress(newQuest, oldHashes, progress, 1, 500);
		expect(out.migrations[0].reason).toBe('params_changed');
	});

	it('leaves the entry alone when the step was not yet completed', () => {
		const oldQuest = makeQuest('q', [
			step({ parameters: ['a', 0.7] }),
			step({ parameters: ['b', 0.7] })
		]);
		const oldHashes = hashQuestSteps(oldQuest.steps);
		const newQuest = makeQuest('q', [
			step({ parameters: ['a', 0.7] }),
			step({ type: 'describe_text', parameters: [[], 0.6] })
		]);
		// only step 0 done; step 1 (which changed) was the user's current step
		const progress: QuestStepProgressEntry[] = [
			{
				type: 'take_photo_classification',
				index: 0,
				submittedAt: 100,
				r2Key: 'r'
			} as QuestStepProgressEntry
		];
		const out = migrateProgress(newQuest, oldHashes, progress, 1, 500);
		// no entry to migrate — but the slot hash changed, so changed is still false?
		// migration only fires when there's something at the position to migrate.
		expect(out.migrations).toHaveLength(0);
		expect(out.changed).toBe(false);
		expect(out.currentStep).toBe(1);
	});
});

describe('migrateProgress — removed steps', () => {
	it('drops entries beyond the new quest length and records step_removed', () => {
		const oldQuest = makeQuest('q', [
			step({ parameters: ['a', 0.7] }),
			step({ parameters: ['b', 0.7] }),
			step({ parameters: ['c', 0.7] })
		]);
		const oldHashes = hashQuestSteps(oldQuest.steps);
		const newQuest = makeQuest('q', [step({ parameters: ['a', 0.7] })]);
		const progress: QuestStepProgressEntry[] = [
			{
				type: 'take_photo_classification',
				index: 0,
				submittedAt: 100,
				r2Key: 'r0'
			} as QuestStepProgressEntry,
			{
				type: 'take_photo_classification',
				index: 1,
				submittedAt: 200,
				r2Key: 'r1'
			} as QuestStepProgressEntry,
			{
				type: 'take_photo_classification',
				index: 2,
				submittedAt: 300,
				r2Key: 'r2'
			} as QuestStepProgressEntry
		];
		const out = migrateProgress(newQuest, oldHashes, progress, 2, 500);
		expect(out.changed).toBe(true);
		expect(out.progress).toHaveLength(1);
		expect(out.migrations.map((m) => m.reason)).toEqual(['step_removed', 'step_removed']);
		expect(out.staleR2Keys).toContain('r1');
		expect(out.staleR2Keys).toContain('r2');
		// currentStep was 2 but the new quest only has 1 step => clamps + auto-completes
		expect(out.currentStep).toBe(1);
		expect(out.completed).toBe(true);
	});
});

describe('migrateProgress — alt-step groups', () => {
	const alt = (params: unknown[]): QuestStep =>
		({ type: 'take_photo_classification', description: 'a', parameters: params }) as QuestStep;

	it('preserves alts whose hash still matches; migrates only the changed one', () => {
		const oldQuest = makeQuest('q', [[alt(['a', 0.7]), alt(['b', 0.7]), alt(['c', 0.7])]]);
		const oldHashes = hashQuestSteps(oldQuest.steps);
		const newQuest = makeQuest('q', [[alt(['a', 0.7]), alt(['b_NEW', 0.7]), alt(['c', 0.7])]]);
		const progress: QuestStepProgressEntry[][] = [
			[
				{
					type: 'take_photo_classification',
					index: 0,
					altIndex: 0,
					submittedAt: 100,
					r2Key: 'r0'
				} as QuestStepProgressEntry,
				{
					type: 'take_photo_classification',
					index: 0,
					altIndex: 1,
					submittedAt: 110,
					r2Key: 'r1'
				} as QuestStepProgressEntry
			]
		];
		const out = migrateProgress(newQuest, oldHashes, progress, 1, 500);
		expect(out.changed).toBe(true);
		const slot = out.progress[0] as QuestStepProgressEntry[];
		expect(slot).toHaveLength(2);
		expect((slot[0] as { r2Key?: string }).r2Key).toBe('r0'); // alt 0 unchanged
		const migratedAlt = slot[1] as QuestStepProgressEntry & { migrated?: { reason: string } };
		expect(migratedAlt.migrated?.reason).toBe('params_changed');
		expect(out.staleR2Keys).toEqual(['r1']);
	});

	it('drops alt entries removed from the group', () => {
		const oldQuest = makeQuest('q', [[alt(['a', 0.7]), alt(['b', 0.7])]]);
		const oldHashes = hashQuestSteps(oldQuest.steps);
		const newQuest = makeQuest('q', [[alt(['a', 0.7])]]);
		const progress: QuestStepProgressEntry[][] = [
			[
				{
					type: 'take_photo_classification',
					index: 0,
					altIndex: 0,
					submittedAt: 100,
					r2Key: 'r0'
				} as QuestStepProgressEntry,
				{
					type: 'take_photo_classification',
					index: 0,
					altIndex: 1,
					submittedAt: 110,
					r2Key: 'r1'
				} as QuestStepProgressEntry
			]
		];
		const out = migrateProgress(newQuest, oldHashes, progress, 1, 500);
		const slot = out.progress[0] as QuestStepProgressEntry[];
		expect(slot).toHaveLength(1);
		expect((slot[0] as { r2Key?: string }).r2Key).toBe('r0');
		expect(out.migrations[0]).toMatchObject({ stepIndex: 0, altIndex: 1, reason: 'alt_removed' });
		expect(out.staleR2Keys).toEqual(['r1']);
	});
});

describe('migrateProgress — currentStep adjustment', () => {
	it('auto-advances currentStep past a migration stub at the in-progress position', () => {
		const oldQuest = makeQuest('q', [
			step({ parameters: ['a', 0.7] }),
			step({ parameters: ['b', 0.7] })
		]);
		const oldHashes = hashQuestSteps(oldQuest.steps);
		const newQuest = makeQuest('q', [
			step({ parameters: ['a', 0.7] }),
			step({ type: 'describe_text', parameters: [[], 0.6] })
		]);
		// step 0 done, step 1 also done (with old type) — currentStep was 1 because last step
		const progress: QuestStepProgressEntry[] = [
			{
				type: 'take_photo_classification',
				index: 0,
				submittedAt: 100,
				r2Key: 'r0'
			} as QuestStepProgressEntry,
			{
				type: 'take_photo_classification',
				index: 1,
				submittedAt: 200,
				r2Key: 'r1'
			} as QuestStepProgressEntry
		];
		const out = migrateProgress(newQuest, oldHashes, progress, 1, 500);
		// step 1 became a migration stub — counts as complete, currentStep advances to 2 (== length => completed)
		expect(out.currentStep).toBe(2);
		expect(out.completed).toBe(true);
	});
});

describe('migrateProgress — distance_covered signal', () => {
	it('emits a cancel_distance_tracking signal when the changed step was distance_covered', () => {
		const oldQuest = makeQuest('q', [
			{
				type: 'distance_covered',
				description: 'run',
				parameters: [1600],
				mobile_only: true
			} as QuestStep
		]);
		const oldHashes = hashQuestSteps(oldQuest.steps);
		const newQuest = makeQuest('q', [
			{
				type: 'distance_covered',
				description: 'run',
				parameters: [3200],
				mobile_only: true
			} as QuestStep
		]);
		// user had submitted progress for the step before its target changed
		const progress: QuestStepProgressEntry[] = [
			{
				type: 'distance_covered',
				index: 0,
				submittedAt: 100,
				distance: 1600
			} as QuestStepProgressEntry
		];
		const out = migrateProgress(newQuest, oldHashes, progress, 1, 500);
		expect(out.signals).toHaveLength(1);
		expect(out.signals[0]).toMatchObject({
			stepIndex: 0,
			action: 'cancel_distance_tracking',
			questId: 'q'
		});
	});
});
