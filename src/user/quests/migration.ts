import type { Quest, QuestStep } from '.';
import type { CustomQuest } from './custom';
import type { QuestStepProgressEntry } from './tracking';

// reasons surfaced to crust/sky so the UI can compose a helpful "this was migrated" banner.
// kept narrow and stable — clients render localized strings keyed off these values.
export type QuestMigrationReason =
	| 'type_changed'
	| 'params_changed'
	| 'step_removed'
	| 'alt_removed'
	| 'quest_deleted';

export type QuestMigrationInfo = {
	from: QuestStep['type']; // old step type at this position (for tombstone display)
	at: number; // unix ms when the migration ran
	reason: QuestMigrationReason;
};

// signal forwarded to sky on the next progress read so background runners can self-cancel
export type QuestMigrationSignal = {
	stepIndex: number;
	altIndex?: number;
	action: 'cancel_distance_tracking';
	questId: string;
};

export type QuestMigrationRecord = {
	stepIndex: number;
	altIndex?: number;
	from: QuestStep['type'];
	reason: QuestMigrationReason;
};

export type MigrationOutcome = {
	changed: boolean;
	progress: (QuestStepProgressEntry | QuestStepProgressEntry[])[];
	currentStep: number;
	completed: boolean;
	// r2 keys whose underlying photo/audio is no longer referenced by any kept entry
	staleR2Keys: string[];
	migrations: QuestMigrationRecord[];
	signals: QuestMigrationSignal[];
	newHashes: string[];
};

// stable JSON of step parameters — sorts object keys so equivalent definitions hash identically
function stableStringify(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
	const keys = Object.keys(value as Record<string, unknown>).sort();
	return (
		'{' +
		keys
			.map((k) => JSON.stringify(k) + ':' + stableStringify((value as Record<string, unknown>)[k]))
			.join(',') +
		'}'
	);
}

// fnv-1a 32-bit, returned as 8 hex chars
// keeps the effective namespace large enough that collisions on real quest params are nil.
function fnv1a32(input: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		h ^= input.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, '0');
}

function hashSingleStep(step: QuestStep): string {
	const canonical = stableStringify({ type: step.type, parameters: step.parameters });
	return `${step.type}@${fnv1a32(canonical)}`;
}

export function hashStepSlot(slot: QuestStep | QuestStep[]): string {
	if (Array.isArray(slot)) {
		return 'alt:' + slot.map(hashSingleStep).join('|');
	}
	return hashSingleStep(slot);
}

export function hashQuestSteps(steps: (QuestStep | QuestStep[])[]): string[] {
	return steps.map(hashStepSlot);
}

// caches the step hashes for any quest (built-in, custom, mastery, activity) keyed by id.
// built-in quests get prewarmed below; everything else lazily fills on first migration check.
const HASH_CACHE = new Map<string, string[]>();

export function getQuestHashes(quest: Quest | CustomQuest): string[] {
	const cached = HASH_CACHE.get(quest.id);
	if (cached) return cached;
	const fresh = hashQuestSteps(quest.steps);
	HASH_CACHE.set(quest.id, fresh);
	return fresh;
}

// invalidate cache for a quest id — call when admin updates a custom quest definition
export function invalidateQuestHashCache(questId: string): void {
	HASH_CACHE.delete(questId);
}

// prewarm built-in quests so the hot read path does zero hashing work.
// require() avoids a circular import at module load — `./index` re-exports types we already use.
export function prewarmBuiltInHashes(quests: Quest[]): void {
	for (const q of quests) {
		HASH_CACHE.set(q.id, hashQuestSteps(q.steps));
	}
}

// parse the step type from a slot hash (single or alt). used to remember the OLD type when
// the new step at that index differs — so the migration record can carry an accurate `from`.
function typesFromHash(hash: string): { primary: QuestStep['type']; alts?: QuestStep['type'][] } {
	if (hash.startsWith('alt:')) {
		const parts = hash.slice(4).split('|');
		const alts = parts.map((p) => p.split('@')[0] as QuestStep['type']);
		return { primary: alts[0], alts };
	}
	return { primary: hash.split('@')[0] as QuestStep['type'] };
}

function entryIsCompleted(
	slot: QuestStepProgressEntry | QuestStepProgressEntry[] | undefined
): boolean {
	if (slot === undefined || slot === null) return false;
	if (Array.isArray(slot)) return slot.length > 0;
	return true;
}

function collectR2Keys(
	slot: QuestStepProgressEntry | QuestStepProgressEntry[] | undefined
): string[] {
	if (!slot) return [];
	const entries = Array.isArray(slot) ? slot : [slot];
	const keys: string[] = [];
	for (const e of entries) {
		if (e && 'r2Key' in e && typeof (e as { r2Key?: unknown }).r2Key === 'string') {
			keys.push((e as { r2Key: string }).r2Key);
		}
	}
	return keys;
}

// build a placeholder entry that signals to crust/sky "this position was a completed
// submission, but the original data is gone because the step definition changed."
function buildMigratedEntry(
	original: QuestStepProgressEntry | undefined,
	newType: QuestStep['type'],
	stepIndex: number,
	altIndex: number | undefined,
	oldType: QuestStep['type'],
	reason: QuestMigrationReason,
	at: number
): QuestStepProgressEntry {
	// preserve submittedAt so the timeline UI can still show "completed on <date>"
	const submittedAt = original?.submittedAt ?? at;
	return {
		type: newType,
		index: stepIndex,
		altIndex,
		submittedAt,
		migrated: { from: oldType, at, reason }
	} as unknown as QuestStepProgressEntry;
}

// diff an alt group: keep alts whose sub-hash matches; replace the rest with migration stubs
function migrateAltSlot(
	oldHash: string,
	newHash: string,
	progressSlot: QuestStepProgressEntry[] | undefined,
	stepIndex: number,
	newAltTypes: QuestStep['type'][],
	oldAltTypes: QuestStep['type'][],
	now: number,
	out: {
		migrations: QuestMigrationRecord[];
		staleR2Keys: string[];
		signals: QuestMigrationSignal[];
		questId: string;
	}
): QuestStepProgressEntry[] {
	const oldSubHashes = oldHash.startsWith('alt:') ? oldHash.slice(4).split('|') : [oldHash];
	const newSubHashes = newHash.startsWith('alt:') ? newHash.slice(4).split('|') : [newHash];

	const existing = progressSlot ?? [];
	const result: QuestStepProgressEntry[] = [];

	for (const entry of existing) {
		const altIdx = entry.altIndex ?? 0;
		const oldSub = oldSubHashes[altIdx];
		const newSub = newSubHashes[altIdx];

		if (!newSub) {
			// alt was removed entirely — drop, record migration, schedule r2 cleanup
			out.staleR2Keys.push(...collectR2Keys(entry));
			out.migrations.push({
				stepIndex,
				altIndex: altIdx,
				from: oldAltTypes[altIdx],
				reason: 'alt_removed'
			});
			if (oldAltTypes[altIdx] === 'distance_covered') {
				out.signals.push({
					stepIndex,
					altIndex: altIdx,
					action: 'cancel_distance_tracking',
					questId: out.questId
				});
			}
			continue;
		}

		if (oldSub === newSub) {
			// unchanged — keep as-is
			result.push(entry);
			continue;
		}

		// alt changed (type or params) — replace with migration stub
		out.staleR2Keys.push(...collectR2Keys(entry));
		const reason: QuestMigrationReason =
			oldAltTypes[altIdx] !== newAltTypes[altIdx] ? 'type_changed' : 'params_changed';
		out.migrations.push({
			stepIndex,
			altIndex: altIdx,
			from: oldAltTypes[altIdx],
			reason
		});
		if (oldAltTypes[altIdx] === 'distance_covered') {
			out.signals.push({
				stepIndex,
				altIndex: altIdx,
				action: 'cancel_distance_tracking',
				questId: out.questId
			});
		}
		result.push(
			buildMigratedEntry(
				entry,
				newAltTypes[altIdx],
				stepIndex,
				altIdx,
				oldAltTypes[altIdx],
				reason,
				now
			)
		);
	}

	return result;
}

// shape-aware migration: aligns by position, preserves untouched entries, replaces touched
// ones with stubs, drops removed-slot entries entirely, and walks currentStep past any newly
// resolved positions. callers persist the result + delete the returned r2 keys.
export function migrateProgress(
	quest: Quest | CustomQuest,
	oldHashes: string[] | undefined,
	progress: (QuestStepProgressEntry | QuestStepProgressEntry[])[],
	currentStep: number,
	now: number = Date.now()
): MigrationOutcome {
	const newHashes = getQuestHashes(quest);
	const newLen = newHashes.length;

	// no prior hashes recorded — adopt the new hashes without claiming a migration
	if (!oldHashes) {
		return {
			changed: false,
			progress,
			currentStep,
			completed: currentStep >= newLen,
			staleR2Keys: [],
			migrations: [],
			signals: [],
			newHashes
		};
	}

	const hashesMatch =
		oldHashes.length === newHashes.length && oldHashes.every((h, i) => h === newHashes[i]);
	if (hashesMatch) {
		return {
			changed: false,
			progress,
			currentStep,
			completed: currentStep >= newLen,
			staleR2Keys: [],
			migrations: [],
			signals: [],
			newHashes
		};
	}

	const migrations: QuestMigrationRecord[] = [];
	const staleR2Keys: string[] = [];
	const signals: QuestMigrationSignal[] = [];
	const newProgress: (QuestStepProgressEntry | QuestStepProgressEntry[])[] = [];

	for (let i = 0; i < newLen; i++) {
		const newHash = newHashes[i];
		const oldHash = oldHashes[i];
		const slot = progress[i];
		const newSlotDef = quest.steps[i];
		const newIsAlt = Array.isArray(newSlotDef);
		const newTypes = typesFromHash(newHash);
		const oldTypes = oldHash ? typesFromHash(oldHash) : undefined;

		if (!oldHash) {
			// new slot added beyond the user's previous quest length — leave empty
			continue;
		}

		if (oldHash === newHash) {
			// unchanged slot
			if (slot !== undefined) newProgress[i] = slot;
			continue;
		}

		// slot changed — alt group or single
		if (newIsAlt) {
			const newAltTypes = newTypes.alts ?? [newTypes.primary];
			const oldAltTypes = oldTypes?.alts ?? (oldTypes ? [oldTypes.primary] : []);

			// special case: old was single, new is alt — promote the single entry into the alts array
			const slotAsArr: QuestStepProgressEntry[] = Array.isArray(slot)
				? slot
				: slot
					? [{ ...slot, altIndex: slot.altIndex ?? 0 } as QuestStepProgressEntry]
					: [];

			const migrated = migrateAltSlot(
				oldHash,
				newHash,
				slotAsArr,
				i,
				newAltTypes,
				oldAltTypes,
				now,
				{ migrations, staleR2Keys, signals, questId: quest.id }
			);
			if (migrated.length > 0) newProgress[i] = migrated;
			continue;
		}

		// new slot is a single step
		const newType = newTypes.primary;
		const oldPrimary = oldTypes?.primary ?? newType;

		if (slot === undefined) {
			// nothing completed here — no entry to migrate
			continue;
		}

		const reason: QuestMigrationReason = oldPrimary !== newType ? 'type_changed' : 'params_changed';

		if (Array.isArray(slot)) {
			// old slot was alt, new is single — preserve any completed alt as a migrated stub
			const first = slot[0];
			staleR2Keys.push(...collectR2Keys(slot));
			migrations.push({ stepIndex: i, from: oldPrimary, reason });
			if (oldPrimary === 'distance_covered') {
				signals.push({
					stepIndex: i,
					action: 'cancel_distance_tracking',
					questId: quest.id
				});
			}
			newProgress[i] = buildMigratedEntry(first, newType, i, undefined, oldPrimary, reason, now);
			continue;
		}

		staleR2Keys.push(...collectR2Keys(slot));
		migrations.push({ stepIndex: i, from: oldPrimary, reason });
		if (oldPrimary === 'distance_covered') {
			signals.push({
				stepIndex: i,
				action: 'cancel_distance_tracking',
				questId: quest.id
			});
		}
		newProgress[i] = buildMigratedEntry(slot, newType, i, undefined, oldPrimary, reason, now);
	}

	// handle entries that fell off the end (steps removed from the quest)
	for (let i = newLen; i < progress.length; i++) {
		const slot = progress[i];
		if (slot === undefined) continue;
		const oldHash = oldHashes[i];
		const oldType = oldHash ? typesFromHash(oldHash).primary : ('unknown' as QuestStep['type']);
		staleR2Keys.push(...collectR2Keys(slot));
		migrations.push({ stepIndex: i, from: oldType, reason: 'step_removed' });
		if (oldType === 'distance_covered') {
			signals.push({
				stepIndex: i,
				action: 'cancel_distance_tracking',
				questId: quest.id
			});
		}
	}

	// sparse array slots round-trip through JSON.stringify as `null`, which the UI already
	// treats as "not yet completed" — no need to explicitly pad here.

	// advance currentStep past any newly-completed (via migration) positions
	let newCurrentStep = Math.min(currentStep, newLen);
	while (newCurrentStep < newLen && entryIsCompleted(newProgress[newCurrentStep])) {
		newCurrentStep++;
	}

	// if currentStep was on a now-removed step, clamp to length
	if (currentStep >= newLen) newCurrentStep = newLen;

	const completed = newCurrentStep >= newLen && newLen > 0;

	// `changed` reflects user-visible mutation (stub entries, dropped entries, cancel signals).
	// when only hashes drifted without touching any completed entry, callers still need to
	// persist new hashes — compare outcome.newHashes vs the input separately for that case.
	const changed = migrations.length > 0;

	return {
		changed,
		progress: newProgress,
		currentStep: newCurrentStep,
		completed,
		staleR2Keys,
		migrations,
		signals,
		newHashes
	};
}

// describe a step type in user-facing prose for the migration notification body
export function describeMigrationCount(records: QuestMigrationRecord[]): string {
	const removed = records.filter(
		(r) => r.reason === 'step_removed' || r.reason === 'alt_removed'
	).length;
	const typeChanged = records.filter((r) => r.reason === 'type_changed').length;
	const paramsChanged = records.filter((r) => r.reason === 'params_changed').length;
	const parts: string[] = [];
	if (typeChanged > 0) parts.push(`${typeChanged} step${typeChanged === 1 ? '' : 's'} replaced`);
	if (paramsChanged > 0)
		parts.push(`${paramsChanged} step${paramsChanged === 1 ? '' : 's'} adjusted`);
	if (removed > 0) parts.push(`${removed} step${removed === 1 ? '' : 's'} removed`);
	return parts.join(', ') || 'updated';
}
