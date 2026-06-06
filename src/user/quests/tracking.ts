import { Buffer } from 'node:buffer';
import { HTTPException } from 'hono/http-exception';
import { getQuest, QuestStep, Quest } from '.';
import type { CustomQuest } from './custom';
import { ActivityType, Bindings, ExecutionCtxLike } from '../../util/types';
import { deflate, encrypt, inflate, decrypt, normalizeId } from '../../util/util';
import { addImpactPoints } from '../points';
import { pushLiveMessage, sendUserNotification } from '../notifications';
import { tryCache } from '../../util/cache';
import {
	BarcodeResolution,
	normalizeThreshold,
	QuestDeviceMetadata,
	validateStep
} from './validation';
import { markBadgeMastered, masteryBadgeIdFromQuestId } from '../badges/mastery';
import { addBadgeProgress } from '../badges';
import {
	describeMigrationCount,
	getQuestHashes,
	migrateProgress,
	QuestMigrationInfo,
	QuestMigrationSignal,
	type MigrationOutcome
} from './migration';

export type QuestProgress = {
	questId: string;
	currentStep: number; // index of the current step the user is on
	completed: boolean; // whether the quest has been completed
	startedAt?: number; // unix ms when the quest was started
	hashes?: string[]; // per-step content hashes; presence drives migration detection
};

// used during request handling - contains actual binary data for ai validation
export type QuestStepResponse = { type: QuestStep['type']; index: number; altIndex?: number } & (
	| {
			type:
				| 'take_photo_location'
				| 'take_photo_classification'
				| 'take_photo_caption'
				| 'draw_picture'
				| 'take_photo_objects'
				| 'take_photo_validation'
				| 'take_photo_list';
			data: Uint8Array;
	  }
	| {
			type: 'attend_event' | 'submit_event_image';
			eventId: string;
			timestamp: number; // unix ms when the event was attended
			score?: number; // from submit_event_image
	  }
	| { type: 'transcribe_audio'; data: Uint8Array }
	| {
			type: 'article_quiz';
			scoreKey: string; // key to look up the user's quiz score for this article in KV
			score: number;
	  }
	| { type: 'match_terms' | 'order_items' | 'respond_to_prompt' } // validated externally via separate endpoints
	| { type: 'distance_covered'; distance: number } // accelerometer-derived meters, validated externally
	| { type: 'describe_text'; text: string }
	| { type: 'article_read_time' | 'activity_read_time'; duration: number }
	| { type: 'scan_barcode'; data: string; format: number }
);

// stored in kv - binary data is replaced with an r2 bucket key.
// when `migrated` is present the entry is a placeholder for a previously-completed step
// whose definition has since changed; submission-specific fields (r2Key, text, etc.) may be absent.
export type QuestStepProgressEntry = {
	type: QuestStep['type'];
	index: number;
	altIndex?: number;
	submittedAt: number; // unix ms when this step was submitted
	migrated?: QuestMigrationInfo; // present iff this entry was rewritten by the migration pass
} & (
	| {
			type:
				| 'take_photo_location'
				| 'take_photo_classification'
				| 'take_photo_caption'
				| 'draw_picture'
				| 'take_photo_objects'
				| 'take_photo_validation'
				| 'take_photo_list';
			score?: number; // validation score (e.g. confidence) for this step submission, if applicable
			prompt?: string; // generated prompt from take_photo_caption, take_photo_validation, or take_photo_list
			r2Key?: string;
	  }
	| { type: 'attend_event'; eventId?: string; timestamp?: number }
	| { type: 'transcribe_audio'; r2Key?: string }
	| { type: 'article_quiz'; scoreKey?: string; score?: number }
	| { type: 'describe_text'; text?: string; score?: number; prompt?: string }
	| { type: 'respond_to_prompt'; text?: string } // text represents the user's response to the prompt
	| { type: 'article_read_time' | 'activity_read_time'; duration?: number }
	| { type: 'submit_event_image'; eventId?: string; score?: number }
	| { type: 'distance_covered'; distance?: number }
	| {
			type: 'scan_barcode';
			kind?: BarcodeResolution['kind'];
			title?: string;
			metadata?: Record<string, unknown>;
	  }
	// contains no additional data
	| { type: 'match_terms' | 'order_items' }
);

// r2 path for a step's binary payload
function stepR2Key(userId: string, questId: string, stepIndex: number, altIndex: number): string {
	return `users/${userId}/quests/${questId}/step_${stepIndex}_${altIndex}.bin`;
}

// compress then encrypt before writing to r2
async function encryptForR2(data: Uint8Array, key: string): Promise<Uint8Array> {
	const compressed = await deflate(data);
	return encrypt(compressed, key);
}

// decrypt then decompress after reading from r2
async function decryptFromR2(data: Uint8Array, key: string): Promise<Uint8Array> {
	const decrypted = await decrypt(data, key);
	return inflate(decrypted);
}

// upload step binary payload to r2 (compressed + encrypted)
async function uploadStepData(data: Uint8Array, r2Key: string, bindings: Bindings): Promise<void> {
	const payload = await encryptForR2(data, bindings.ENCRYPTION_KEY);
	await bindings.R2.put(r2Key, payload);
}

// download and decrypt step binary payload from r2
export async function downloadStepData(
	r2Key: string,
	bindings: Bindings
): Promise<Uint8Array | null> {
	const obj = await bindings.R2.get(r2Key);
	if (!obj) return null;
	const buffer = await obj.arrayBuffer();
	return decryptFromR2(new Uint8Array(buffer), bindings.ENCRYPTION_KEY);
}

// Detect MIME type from magic bytes
function detectMimeType(data: Uint8Array, stepType: string): string {
	if (stepType === 'draw_picture') return 'image/png';
	if (stepType === 'transcribe_audio') {
		// MP3: sync word or ID3 tag
		if (data.length >= 3 && data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33)
			return 'audio/mpeg';
		if (data.length >= 2 && data[0] === 0xff && (data[1] & 0xe0) === 0xe0) return 'audio/mpeg';
		// WAV: RIFF....WAVE
		if (
			data.length >= 12 &&
			data[0] === 0x52 &&
			data[1] === 0x49 &&
			data[2] === 0x46 &&
			data[3] === 0x46 &&
			data[8] === 0x57 &&
			data[9] === 0x41 &&
			data[10] === 0x56 &&
			data[11] === 0x45
		)
			return 'audio/wav';
		// CAF: caff
		if (
			data.length >= 4 &&
			data[0] === 0x63 &&
			data[1] === 0x61 &&
			data[2] === 0x66 &&
			data[3] === 0x66
		)
			return 'audio/x-caf';
		// M4A: ftyp box with M4A/M4B major brand
		if (
			data.length >= 12 &&
			data[4] === 0x66 &&
			data[5] === 0x74 &&
			data[6] === 0x79 &&
			data[7] === 0x70 &&
			data[8] === 0x4d &&
			data[9] === 0x34 &&
			(data[10] === 0x41 || data[10] === 0x42) &&
			data[11] === 0x20
		)
			return 'audio/mp4';
		return 'audio/octet-stream';
	}
	// Photos
	if (data.length >= 2 && data[0] === 0xff && data[1] === 0xd8) return 'image/jpeg';
	if (
		data.length >= 4 &&
		data[0] === 0x89 &&
		data[1] === 0x50 &&
		data[2] === 0x4e &&
		data[3] === 0x47
	)
		return 'image/png';
	if (
		data.length >= 12 &&
		data[0] === 0x52 &&
		data[1] === 0x49 &&
		data[2] === 0x46 &&
		data[3] === 0x46 &&
		data[8] === 0x57 &&
		data[9] === 0x45 &&
		data[10] === 0x42 &&
		data[11] === 0x50
	)
		return 'image/webp';
	return 'image/jpeg';
}

// Enrich a single progress entry that has an r2Key by downloading and converting to data URL
async function enrichEntry(
	entry: QuestStepProgressEntry,
	bindings: Bindings
): Promise<QuestStepProgressEntry & { data?: string }> {
	if (!('r2Key' in entry)) return entry;
	const raw = await downloadStepData(
		(entry as QuestStepProgressEntry & { r2Key: string }).r2Key,
		bindings
	);
	if (!raw) return entry;
	const mime = detectMimeType(raw, entry.type);
	const base64 = Buffer.from(raw).toString('base64');
	return { ...entry, data: `data:${mime};base64,${base64}` };
}

// Enrich all entries in a progress array with data URLs for binary payloads
export async function enrichProgressEntries(
	entries: (QuestStepProgressEntry | QuestStepProgressEntry[])[],
	bindings: Bindings
): Promise<(QuestStepProgressEntry | QuestStepProgressEntry[])[]> {
	return Promise.all(
		entries.map((entry) =>
			Array.isArray(entry)
				? Promise.all(entry.map((e) => enrichEntry(e, bindings)))
				: enrichEntry(entry, bindings)
		)
	);
}

// convert a QuestStepResponse (with binary) to a QuestStepProgressEntry (with r2 key)
async function toProgressEntry(
	response: QuestStepResponse,
	userId: string,
	questId: string,
	submittedAt: number,
	bindings: Bindings,
	score?: number,
	prompt?: string,
	kind?: BarcodeResolution['kind'],
	title?: string,
	metadata?: Record<string, unknown>
): Promise<QuestStepProgressEntry> {
	const altIdx = response.altIndex ?? 0;

	if (
		response.type === 'take_photo_location' ||
		response.type === 'take_photo_classification' ||
		response.type === 'take_photo_caption' ||
		response.type === 'draw_picture' ||
		response.type === 'take_photo_objects' ||
		response.type === 'take_photo_validation' ||
		response.type === 'take_photo_list'
	) {
		const r2Key = stepR2Key(userId, questId, response.index, altIdx);
		await uploadStepData(response.data, r2Key, bindings);
		const entry: QuestStepProgressEntry = {
			type: response.type,
			index: response.index,
			altIndex: response.altIndex,
			submittedAt,
			score,
			prompt,
			r2Key
		} as QuestStepProgressEntry;
		return entry;
	}

	if (response.type === 'transcribe_audio') {
		const r2Key = stepR2Key(userId, questId, response.index, altIdx);
		await uploadStepData(response.data, r2Key, bindings);
		return {
			type: 'transcribe_audio',
			index: response.index,
			altIndex: response.altIndex,
			submittedAt,
			r2Key
		};
	}

	if (response.type === 'describe_text') {
		return {
			type: 'describe_text',
			index: response.index,
			altIndex: response.altIndex,
			submittedAt,
			text: response.text,
			score,
			prompt
		};
	}

	if (response.type === 'scan_barcode') {
		if (!kind || !title) {
			throw new Error('scan_barcode progress entry requires resolved kind and title');
		}

		return {
			type: 'scan_barcode',
			index: response.index,
			altIndex: response.altIndex,
			submittedAt,
			kind,
			title,
			metadata: metadata ?? {}
		};
	}

	// no validation here — payload (if any) is spread into the entry as-is:
	// - attend_event ({ eventId, timestamp })
	// - article_quiz ({ scoreKey, score })
	// - submit_event_image ({ eventId, score })
	// - distance_covered ({ distance })
	// - match_terms / order_items / respond_to_prompt (no body payload from cloud's perspective)

	return { ...(response as unknown as QuestStepProgressEntry), submittedAt };
}

// delete all r2 objects associated with a progress array
async function cleanupR2(
	entries: (QuestStepProgressEntry | QuestStepProgressEntry[])[],
	bindings: Bindings
): Promise<void> {
	const flat = entries.flat() as QuestStepProgressEntry[];
	await Promise.all(
		flat
			.filter((e): e is QuestStepProgressEntry & { r2Key: string } => 'r2Key' in e)
			.map((e) => bindings.R2.delete(e.r2Key))
	);
}

// archive completed quest progress to r2 (encrypted+compressed), kv stores the r2 key
async function archiveCompletedQuest(
	userId: string,
	questId: string,
	progress: (QuestStepProgressEntry | QuestStepProgressEntry[])[],
	bindings: Bindings
): Promise<void> {
	// serialize, compress, and encrypt the full progress for r2 storage
	const r2Key = `users/${userId}/quests/${questId}/history.bin`;
	const jsonBytes = new TextEncoder().encode(JSON.stringify(progress));
	const payload = await encryptForR2(jsonBytes, bindings.ENCRYPTION_KEY);
	await bindings.R2.put(r2Key, payload, {
		httpMetadata: { contentType: 'application/octet-stream' }
	});

	// snapshot the live quest hashes alongside the pointer; future reads compare against
	// this baseline to detect quest definition drift and migrate the archive on the fly.
	const quest = await getQuest(questId, bindings, userId);
	const hashes = quest ? getQuestHashes(quest) : undefined;

	// kv stores r2 path + completion time as a small json value (no large payload)
	const completedAt = Date.now();
	await bindings.KV.put(
		`user:quest_history:${userId}:${questId}`,
		JSON.stringify({ r2Key, completedAt, hashes }),
		{ metadata: { questId, completedAt } }
	);

	// update the history index
	const indexKey = `user:quest_history_index:${userId}`;
	const existing = (await bindings.KV.get<string[]>(indexKey, 'json')) || [];
	if (!existing.includes(questId)) {
		await bindings.KV.put(indexKey, JSON.stringify([...existing, questId]));
	}

	// remove the active progress key — quest is now immutably in history
	await bindings.KV.delete(`user:quest_progress:${userId}`);
}

// per-rank reduction (fraction 0..1) applied to QuestStep.delay; administrator bypasses entirely.
// mirrors the cosmetics-discount pattern in mantle2's PointsHelper::getPriceDiscount — keep in sync.
export const QUEST_DELAY_REDUCTION_BY_RANK: Record<string, number> = {
	free: 0,
	pro: 0.1,
	writer: 0.25,
	organizer: 0.5,
	administrator: 1
};

export function getQuestDelayReduction(rank?: string | null): number {
	if (!rank) return 0;
	const normalized = rank.trim().toLowerCase();
	return QUEST_DELAY_REDUCTION_BY_RANK[normalized] ?? 0;
}

export async function checkStepDelay(
	userId: string,
	stepIndex: number,
	altIndex: number | undefined,
	bindings: Bindings,
	rank?: string | null
): Promise<{ available: boolean; secondsRemaining?: number; availableAt?: number }> {
	const userId0 = normalizeId(userId);
	const res = await bindings.KV.getWithMetadata<
		(QuestStepProgressEntry | QuestStepProgressEntry[])[],
		QuestProgress
	>(`user:quest_progress:${userId0}`, 'json');

	const progress = res.value || [];
	const metadata = res.metadata;

	// No active quest or step is not current — delay does not apply
	if (!metadata || stepIndex !== metadata.currentStep) return { available: true };

	const quest = await getQuest(metadata.questId, bindings, userId0);
	if (!quest) return { available: true };

	const targetStepDef = quest.steps[stepIndex];
	if (!targetStepDef) return { available: true };

	const isAltStep = Array.isArray(targetStepDef);
	const stepDef = isAltStep
		? (targetStepDef as QuestStep[])[altIndex ?? 0]
		: (targetStepDef as QuestStep);

	if (!stepDef?.delay) return { available: true };

	const reduction = getQuestDelayReduction(rank);
	// full bypass for administrators (and any future 100%-off rank)
	if (reduction >= 1) return { available: true };

	let baseTime: number;
	if (stepIndex === 0) {
		baseTime = metadata.startedAt ?? 0;
	} else {
		const prevEntry = progress[stepIndex - 1];
		if (Array.isArray(prevEntry)) {
			baseTime = (prevEntry as QuestStepProgressEntry[])[0]?.submittedAt ?? 0;
		} else {
			baseTime = (prevEntry as QuestStepProgressEntry)?.submittedAt ?? 0;
		}
	}

	const effectiveDelayMs = Math.round(stepDef.delay * (1 - reduction) * 1000);
	const availableAt = baseTime + effectiveDelayMs;
	const now = Date.now();
	if (now < availableAt) {
		const secondsRemaining = Math.ceil((availableAt - now) / 1000);
		return { available: false, secondsRemaining, availableAt };
	}

	return { available: true };
}

/**
 * If the active progress KV entry is marked completed but was never archived
 * (e.g. the background task crashed), archive it now and send the completion
 * notification.  Safe to call multiple times — archiveCompletedQuest is idempotent
 * because it overwrites the same R2 key and only appends to the history index if
 * the quest is not already present.
 */
export async function maybeArchiveCompletedQuest(
	userId: string,
	bindings: Bindings,
	ctx?: ExecutionCtxLike
): Promise<void> {
	const userId0 = normalizeId(userId);
	const res = await bindings.KV.getWithMetadata<
		(QuestStepProgressEntry | QuestStepProgressEntry[])[],
		QuestProgress
	>(`user:quest_progress:${userId0}`, 'json');

	if (!res.metadata?.completed || !res.metadata?.questId) return;

	const quest = await getQuest(res.metadata.questId, bindings, userId0);
	const progress = res.value || [];

	const doArchive = async () => {
		await archiveCompletedQuest(userId0, res.metadata!.questId, progress, bindings);
		if (quest) {
			await sendUserNotification(
				bindings,
				userId0,
				`Quest "${quest.title}" Completed!`,
				`You have successfully completed the quest and earned ${quest.reward} impact points!`,
				undefined,
				'success',
				'quest'
			);
		}
	};

	if (ctx) {
		ctx.waitUntil(doArchive());
	} else {
		await doArchive();
	}
}

// dedupe key for migration notifications — one per (user, quest) per 24h so quick
// successive CRU calls don't spam the user.
function migrationNotifiedKey(userId: string, questId: string): string {
	return `user:quest_migration_notified:${userId}:${questId}`;
}

type EnsureMigratedResult = {
	progress: (QuestStepProgressEntry | QuestStepProgressEntry[])[];
	metadata: QuestProgress | null;
	signals: QuestMigrationSignal[];
	migrated: boolean;
	archivedAfter: boolean; // true if migration pushed the quest into a completed state
};

// if the quest definition's hashes no longer match the stored ones, rewrite the user's
// progress in-place (replacing affected entries with migration stubs), delete dangling
// r2 keys, notify once per quest, and bubble up any sky-runner cancel signals.
// safe to call on every read — when nothing has changed it returns the input untouched.
async function ensureMigrated(
	userId0: string,
	res: {
		value: (QuestStepProgressEntry | QuestStepProgressEntry[])[] | null;
		metadata: QuestProgress | null;
	},
	quest: Quest | CustomQuest | null,
	bindings: Bindings,
	ctx?: ExecutionCtxLike
): Promise<EnsureMigratedResult> {
	const progress = res.value || [];
	const metadata = res.metadata;

	if (!metadata || !metadata.questId) {
		return {
			progress,
			metadata,
			signals: [],
			migrated: false,
			archivedAfter: false
		};
	}

	// quest was deleted entirely — wipe the active progress, notify, return empty state
	if (!quest) {
		const r2Keys = progress.flat().flatMap((e) => {
			if (e && 'r2Key' in e && typeof (e as { r2Key?: unknown }).r2Key === 'string') {
				return [(e as { r2Key: string }).r2Key];
			}
			return [];
		});

		const cleanup = async () => {
			await Promise.all([
				bindings.KV.delete(`user:quest_progress:${userId0}`),
				...r2Keys.map((k) => bindings.R2.delete(k)),
				(async () => {
					const seen = await bindings.KV.get(migrationNotifiedKey(userId0, metadata.questId));
					if (seen) return;
					await sendUserNotification(
						bindings,
						userId0,
						'Quest discontinued',
						`The quest you were working on is no longer available, and your progress has been cleared.`,
						undefined,
						'info',
						'quest'
					);
					await bindings.KV.put(migrationNotifiedKey(userId0, metadata.questId), '1', {
						expirationTtl: 60 * 60 * 24
					});
				})()
			]);
		};

		if (ctx) ctx.waitUntil(cleanup());
		else await cleanup();

		console.log(
			`[quest-migration] quest "${metadata.questId}" no longer exists for user ${userId0} - reset`
		);

		return {
			progress: [],
			metadata: null,
			signals: [],
			migrated: true,
			archivedAfter: false
		};
	}

	const outcome: MigrationOutcome = migrateProgress(
		quest,
		metadata.hashes,
		progress,
		metadata.currentStep ?? 0
	);

	const hashesDrifted =
		!metadata.hashes ||
		metadata.hashes.length !== outcome.newHashes.length ||
		metadata.hashes.some((h, i) => h !== outcome.newHashes[i]);

	// no user-visible migration. either nothing drifted (true no-op) or only hashes drifted
	// without touching completed entries — in the latter case we still want to refresh hashes
	// so we don't redo the diff on every read.
	if (!outcome.changed) {
		if (hashesDrifted) {
			const newMeta: QuestProgress = { ...metadata, hashes: outcome.newHashes };
			const persist = bindings.KV.put(`user:quest_progress:${userId0}`, JSON.stringify(progress), {
				metadata: newMeta
			});
			if (ctx) ctx.waitUntil(persist);
			else await persist;
			return {
				progress,
				metadata: newMeta,
				signals: [],
				migrated: false,
				archivedAfter: false
			};
		}
		return {
			progress,
			metadata,
			signals: [],
			migrated: false,
			archivedAfter: false
		};
	}

	console.log(
		`[quest-migration] user=${userId0} quest=${quest.id} ` +
			`migrations=${outcome.migrations.length} stale_r2=${outcome.staleR2Keys.length} ` +
			`signals=${outcome.signals.length} reasons=${outcome.migrations.map((m) => m.reason).join('|')}`
	);

	const newMeta: QuestProgress = {
		questId: metadata.questId,
		currentStep: outcome.currentStep,
		completed: outcome.completed,
		startedAt: metadata.startedAt,
		hashes: outcome.newHashes
	};

	const persist = async () => {
		// when the migration auto-completes the quest, archive immediately (and clear active key)
		if (outcome.completed) {
			await archiveCompletedQuest(userId0, quest.id, outcome.progress, bindings);
		} else {
			await bindings.KV.put(`user:quest_progress:${userId0}`, JSON.stringify(outcome.progress), {
				metadata: newMeta
			});
		}
		// remove the orphaned r2 objects
		await Promise.all(outcome.staleR2Keys.map((k) => bindings.R2.delete(k)));

		// notify at most once per (user, quest) per day
		const seen = await bindings.KV.get(migrationNotifiedKey(userId0, quest.id));
		if (!seen) {
			await sendUserNotification(
				bindings,
				userId0,
				`Quest "${quest.title}" updated`,
				`Some steps in this quest have changed (${describeMigrationCount(outcome.migrations)}). Your previous progress has been preserved where possible.`,
				undefined,
				'info',
				'quest'
			);
			await bindings.KV.put(migrationNotifiedKey(userId0, quest.id), '1', {
				expirationTtl: 60 * 60 * 24
			});
		}
	};

	if (ctx) ctx.waitUntil(persist());
	else await persist();

	return {
		progress: outcome.progress,
		metadata: outcome.completed ? null : newMeta,
		signals: outcome.signals,
		migrated: true,
		archivedAfter: outcome.completed
	};
}

export async function getCurrentQuestProgress(
	userId: string,
	bindings: Bindings,
	ctx?: ExecutionCtxLike
) {
	const userId0 = normalizeId(userId);
	// progress entries are QuestStepProgressEntry for normal steps, QuestStepProgressEntry[] for alt steps
	const res = await bindings.KV.getWithMetadata<
		(QuestStepProgressEntry | QuestStepProgressEntry[])[],
		QuestProgress
	>(`user:quest_progress:${userId0}`, 'json');

	const quest = res.metadata?.questId
		? await getQuest(res.metadata.questId, bindings, userId0)
		: null;

	const migrated = await ensureMigrated(userId0, res, quest, bindings, ctx);
	const meta = migrated.metadata;
	const liveQuest = meta?.questId === quest?.id ? quest : null;

	return {
		progress: migrated.progress,
		quest: liveQuest,
		questId: meta?.questId || null,
		currentStep:
			liveQuest && meta?.currentStep !== undefined
				? liveQuest.steps[meta.currentStep] || null
				: null,
		currentStepIndex: meta?.currentStep || 0,
		completed: migrated.archivedAfter || meta?.completed || false,
		migrationSignals: migrated.signals,
		migrated: migrated.migrated
	};
}

// get the list of completed quest IDs for a user
export async function getQuestHistory(userId: string, bindings: Bindings): Promise<string[]> {
	const userId0 = normalizeId(userId);
	return (await bindings.KV.get<string[]>(`user:quest_history_index:${userId0}`, 'json')) || [];
}

// historical archive's stored hash list lives in the KV pointer record so we can detect
// a definition drift since the user completed the quest.
type HistoryPointer = { r2Key: string; completedAt: number; hashes?: string[] };

// get the full progress for a completed quest. archive is normally immutable, but if the
// quest definition has drifted since completion we migrate-on-read, rewrite the archive,
// and invalidate the cache so future fetches hit the migrated form for free.
export async function getCompletedQuestProgress(
	userId: string,
	questId: string,
	bindings: Bindings,
	ctx?: ExecutionCtxLike
) {
	const userId0 = normalizeId(userId);

	const pointerKey = `user:quest_history:${userId0}:${questId}`;
	const res = await bindings.KV.get<HistoryPointer>(pointerKey, 'json');
	if (!res) return null;

	const { r2Key, completedAt } = res;
	const quest = await getQuest(questId, bindings, userId0);

	// drift check: archive's stored hashes vs current quest. if quest is gone or differs,
	// we bypass the cache, migrate the decoded archive, and rewrite r2 + the pointer.
	const currentHashes = quest ? getQuestHashes(quest) : undefined;
	const archiveHashes = res.hashes;
	const driftDetected =
		quest != null &&
		(!archiveHashes ||
			archiveHashes.length !== currentHashes!.length ||
			archiveHashes.some((h, i) => h !== currentHashes![i]));

	if (driftDetected && quest) {
		// always read fresh (not from cache) when migrating
		const obj = await bindings.R2.get(r2Key);
		if (!obj) return null;
		const decrypted = await decryptFromR2(
			new Uint8Array(await obj.arrayBuffer()),
			bindings.ENCRYPTION_KEY
		);
		const rawProgress = JSON.parse(new TextDecoder().decode(decrypted)) as (
			| QuestStepProgressEntry
			| QuestStepProgressEntry[]
		)[];

		const outcome = migrateProgress(quest, archiveHashes, rawProgress, quest.steps.length);

		if (outcome.changed) {
			console.log(
				`[quest-migration:history] user=${userId0} quest=${questId} ` +
					`migrations=${outcome.migrations.length} stale_r2=${outcome.staleR2Keys.length}`
			);

			const rewrite = async () => {
				const jsonBytes = new TextEncoder().encode(JSON.stringify(outcome.progress));
				const payload = await encryptForR2(jsonBytes, bindings.ENCRYPTION_KEY);
				await Promise.all([
					bindings.R2.put(r2Key, payload, {
						httpMetadata: { contentType: 'application/octet-stream' }
					}),
					bindings.KV.put(
						pointerKey,
						JSON.stringify({
							r2Key,
							completedAt,
							hashes: outcome.newHashes
						} satisfies HistoryPointer),
						{ metadata: { questId, completedAt } }
					),
					bindings.CACHE.delete(`cache:quest_history:${userId0}:${questId}`),
					...outcome.staleR2Keys.map((k) => bindings.R2.delete(k))
				]);
			};
			if (ctx) ctx.waitUntil(rewrite());
			else await rewrite();

			return { progress: outcome.progress, quest, questId, completedAt };
		}

		// no real diff (e.g. only hashes field was missing) — backfill hashes and fall through to cached path
		if (!archiveHashes) {
			const persist = bindings.KV.put(
				pointerKey,
				JSON.stringify({ r2Key, completedAt, hashes: outcome.newHashes } satisfies HistoryPointer),
				{ metadata: { questId, completedAt } }
			);
			if (ctx) ctx.waitUntil(persist);
			else await persist;
		}
	}

	// cache the r2 download (the expensive part) since the archive is immutable in the steady state
	return tryCache(
		`cache:quest_history:${userId0}:${questId}`,
		bindings.CACHE,
		async () => {
			const obj = await bindings.R2.get(r2Key);
			if (!obj) return null;
			const decrypted = await decryptFromR2(
				new Uint8Array(await obj.arrayBuffer()),
				bindings.ENCRYPTION_KEY
			);
			const progress = JSON.parse(new TextDecoder().decode(decrypted)) as (
				| QuestStepProgressEntry
				| QuestStepProgressEntry[]
			)[];
			return { progress, quest, questId, completedAt };
		},
		60 * 60
	);
}

// starts a new quest - cleans up r2 data for unfinished quests, preserves completed history
export async function startQuest(userId: string, questId: string, bindings: Bindings) {
	const userId0 = normalizeId(userId);

	// block restarting a quest the user has already completed
	const historyIndex =
		(await bindings.KV.get<string[]>(`user:quest_history_index:${userId0}`, 'json')) || [];
	if (historyIndex.includes(questId)) {
		throw new HTTPException(409, {
			message: `Quest "${questId}" has already been completed and cannot be restarted`
		});
	}

	// check for existing quest and clean up r2 if it was unfinished (not yet archived)
	const existing = await bindings.KV.getWithMetadata<
		(QuestStepProgressEntry | QuestStepProgressEntry[])[],
		QuestProgress
	>(`user:quest_progress:${userId0}`, 'json');

	if (existing.metadata && !existing.metadata.completed && existing.value?.length) {
		// unfinished: binary data was never archived, delete from r2
		await cleanupR2(existing.value, bindings);
	}

	// snapshot the live step hashes so a later definition change is detectable
	const quest = await getQuest(questId, bindings, userId0);
	const hashes = quest ? getQuestHashes(quest) : undefined;

	await bindings.KV.put(`user:quest_progress:${userId0}`, JSON.stringify([]), {
		metadata: {
			questId,
			currentStep: 0,
			completed: false,
			startedAt: Date.now(),
			hashes
		} satisfies QuestProgress
	});

	console.log(`User ${userId} started quest "${questId}"`);
}

export async function resetQuestProgress(userId: string, bindings: Bindings) {
	const userId0 = normalizeId(userId);

	// clean up r2 objects for the active quest
	const existing = await bindings.KV.getWithMetadata<
		(QuestStepProgressEntry | QuestStepProgressEntry[])[],
		QuestProgress
	>(`user:quest_progress:${userId0}`, 'json');

	if (existing.value?.length) {
		await cleanupR2(existing.value, bindings);
	}

	await bindings.KV.delete(`user:quest_progress:${userId0}`);
	console.log(`User ${userId} reset their active quest progress`);
}

// phase markers consumed by Server-Timing in the quest-submit handler. opt-in so other
// call sites (timer.ts, event submissions) don't need to know about timing diagnostics
export type QuestPhaseRecorder = (phase: string) => void;

export async function updateQuestProgress(
	userId: string,
	stepResponse: QuestStepResponse,
	device: QuestDeviceMetadata,
	bindings: Bindings,
	ctx: ExecutionCtxLike,
	rank?: string | null,
	recordPhase?: QuestPhaseRecorder
) {
	const userId0 = normalizeId(userId);
	const res = await bindings.KV.getWithMetadata<
		(QuestStepProgressEntry | QuestStepProgressEntry[])[],
		QuestProgress
	>(`user:quest_progress:${userId0}`, 'json');

	const quest0 = res.metadata?.questId
		? await getQuest(res.metadata.questId, bindings, userId0)
		: null;

	// run migration before reading the working set — keeps the write path consistent with reads
	const migrated = await ensureMigrated(userId0, res, quest0, bindings, ctx);

	const progress = migrated.progress;
	const metadata = migrated.metadata || {
		currentStep: 0,
		questId: '',
		completed: false,
		startedAt: undefined
	};

	// ignore if quest already completed (or auto-completed by migration)
	if (migrated.archivedAfter || metadata.completed) {
		throw new HTTPException(409, { message: 'Quest already completed' });
	}

	const quest = metadata.questId ? await getQuest(metadata.questId, bindings, userId0) : null;
	if (!quest) {
		throw new HTTPException(404, { message: 'No active quest found' });
	}

	const idx = stepResponse.index;

	// cannot submit future steps; past alt steps can be submitted for extra points
	if (idx > metadata.currentStep || idx >= quest.steps.length) {
		throw new HTTPException(400, {
			message: 'Submitted step index does not match current quest progress'
		});
	}

	const targetStepDef = quest.steps[idx];
	if (!targetStepDef) {
		throw new HTTPException(404, { message: 'Step not found in quest' });
	}

	const isAltStep = Array.isArray(targetStepDef);

	// delay validation: only gates advancement of the current step, not backfilling of past alt steps.
	if (idx === metadata.currentStep) {
		const delayStatus = await checkStepDelay(userId, idx, stepResponse.altIndex, bindings, rank);
		if (!delayStatus.available) {
			const s = delayStatus.secondsRemaining!;
			throw new HTTPException(425, {
				message: `Step not yet available. Try again in ${s} second${s === 1 ? '' : 's'}.`
			});
		}
	}

	let submittingStep: QuestStep;
	let isFirstCompletionOfStep: boolean;

	if (isAltStep) {
		const altIndex = stepResponse.altIndex ?? 0;
		const step = targetStepDef[altIndex];
		if (!step) {
			throw new HTTPException(404, { message: 'Submitted alternative step index does not exist' });
		}
		submittingStep = step;

		// check if this specific alt was already completed
		const existingAlts = (progress[idx] as QuestStepProgressEntry[] | undefined) || [];
		if (existingAlts.some((r) => (r.altIndex ?? 0) === altIndex)) {
			throw new HTTPException(409, { message: 'Alternative step already completed successfully' });
		}

		// first successful submission of any alt in the group advances currentStep
		isFirstCompletionOfStep = existingAlts.length === 0;
	} else {
		// normal step - any resubmission is disallowed
		if (progress[idx]) {
			throw new HTTPException(409, { message: 'Step already completed successfully' });
		}
		submittingStep = targetStepDef;
		isFirstCompletionOfStep = true;
	}

	// quest-level mobile_only wins when true: propagate down so a step that omitted the
	// flag still gets device validation in mobile-only quests. CustomQuest omits the flag,
	// so the `in` guard keeps the type narrowing safe.
	const questIsMobileOnly = 'mobile_only' in quest && quest.mobile_only === true;
	const stepForValidation: QuestStep = questIsMobileOnly
		? ({ ...submittingStep, mobile_only: true } as QuestStep)
		: submittingStep;

	// validate step response against step requirements (uses binary data for ai models)
	const validation = await validateStep(stepForValidation, stepResponse, bindings, device);
	recordPhase?.('validate');
	if (!validation.success) {
		throw new HTTPException(400, { message: `Step validation failed: ${validation.message}` });
	}

	// convert binary response to progress entry (uploads to r2)
	const submittedAt = Date.now();
	const progressEntry = await toProgressEntry(
		stepResponse,
		userId0,
		quest.id,
		submittedAt,
		bindings,
		validation.score,
		validation.prompt,
		validation.kind,
		validation.title,
		validation.metadata
	);
	recordPhase?.('upload');

	// update progress array
	const updatedProgress = [...progress] as (QuestStepProgressEntry | QuestStepProgressEntry[])[];
	if (isAltStep) {
		const existingAlts = (progress[idx] as QuestStepProgressEntry[] | undefined) || [];
		updatedProgress[idx] = [...existingAlts, progressEntry];
	} else {
		updatedProgress[idx] = progressEntry;
	}

	// only advance currentStep when this is the first completion of this step and we're currently on it
	const advancesStep = isFirstCompletionOfStep && idx === metadata.currentStep;
	const isLastStep = metadata.currentStep === quest.steps.length - 1;
	const completed = advancesStep && isLastStep;
	const newStepIndex = completed
		? metadata.currentStep
		: metadata.currentStep + (advancesStep ? 1 : 0);

	// preserve hashes (or seed them when missing) so subsequent edits to the quest get detected
	const persistedHashes = metadata.hashes ?? getQuestHashes(quest);

	await bindings.KV.put(`user:quest_progress:${userId0}`, JSON.stringify(updatedProgress), {
		metadata: {
			questId: metadata.questId,
			currentStep: newStepIndex,
			completed,
			startedAt: metadata.startedAt,
			hashes: persistedHashes
		} satisfies QuestProgress
	});
	recordPhase?.('persist');

	console.log(
		`User ${userId} submitted step ${idx}${isAltStep ? ` alt ${stepResponse.altIndex}` : ''} for quest "${quest.title}" - validation: ${validation.success}, completed: ${completed}`
	);

	// stable id for this specific step completion (alt backfills produce a new id)
	const stepTrackerValue = isAltStep
		? `${quest.id}:${idx}:${stepResponse.altIndex ?? 0}`
		: `${quest.id}:${idx}`;
	const questIsGreen = 'rarity' in quest && quest.rarity === 'green';

	ctx.waitUntil(
		Promise.all([
			// archive to history when quest is completed (immutable, r2 keys preserved)
			completed
				? archiveCompletedQuest(userId0, quest.id, updatedProgress, bindings)
				: Promise.resolve(),
			// track quest step completion for badges (counts each unique step, incl. alt backfills)
			addBadgeProgress(userId0, 'quest_steps_completed', stepTrackerValue, bindings.KV),
			questIsGreen
				? addBadgeProgress(userId0, 'quest_steps_completed_green', stepTrackerValue, bindings.KV)
				: Promise.resolve(),
			// live-push step + completion state to any open ws sessions to reflect progress
			pushLiveMessage(bindings, userId0, 'quest_progress', {
				questId: quest.id,
				stepIndex: idx,
				altIndex: isAltStep ? (stepResponse.altIndex ?? 0) : undefined,
				validated: validation.success,
				completed,
				stepReward: submittingStep.reward ?? 0,
				questReward: completed ? quest.reward : 0
			}),
			// award step reward and/or quest completion points, then notify
			(async () => {
				if (submittingStep.reward) {
					await addImpactPoints(
						userId0,
						submittingStep.reward,
						`Quest "${quest.title}" | Step #${idx + 1}${isFirstCompletionOfStep ? '' : ' (alt)'}`,
						bindings.KV
					);
				}

				if (completed) {
					await addImpactPoints(
						userId0,
						quest.reward,
						`Quest "${quest.title}" Completion`,
						bindings.KV
					);

					// If this is a badge mastery quest, set the mastered marker before notifying
					// so the notification and any subsequent badge lookups see the new state.
					const masteredBadgeId = masteryBadgeIdFromQuestId(quest.id);
					if (masteredBadgeId) {
						await markBadgeMastered(userId0, masteredBadgeId, bindings.KV);
					}

					await sendUserNotification(
						bindings,
						userId0,
						`Quest "${quest.title}" Completed!`,
						`You have successfully completed the quest and earned ${quest.reward} impact points!`,
						undefined,
						'success',
						'quest'
					);
				}
			})()
		])
	);

	return { completed, message: validation.message, validated: validation.success };
}

export async function handleQuizQuestStep(
	userId: string,
	scoreKey: string,
	scorePercent: number,
	articleTypes: ActivityType[] | undefined,
	bindings: Bindings,
	ctx: ExecutionCtxLike
): Promise<{ handled: boolean; completed?: boolean; message?: string }> {
	if (!articleTypes || articleTypes.length === 0) {
		console.log(`handleQuizQuestStep: no article types provided for user ${userId}, skipping`);
		return { handled: false };
	}

	try {
		const questProgress = await getCurrentQuestProgress(userId, bindings);
		const currentQuest = questProgress.quest;
		const currentStepIndex = questProgress.currentStepIndex;
		const progress = questProgress.progress;

		if (!currentQuest) {
			console.log(`handleQuizQuestStep: no active quest for user ${userId}, skipping`);
			return { handled: false };
		}

		if (questProgress.completed) {
			console.log(
				`handleQuizQuestStep: quest "${currentQuest.title}" already completed for user ${userId}, skipping`
			);
			return { handled: false };
		}

		let matchedStepIndex: number | null = null;
		let matchedAltIndex: number | undefined = undefined;
		let matchedStepDef: QuestStep | null = null;
		let thresholdPercent = 0;

		for (let idx = currentStepIndex; idx >= 0; idx--) {
			const stepDef = currentQuest.steps[idx];
			if (!stepDef) continue;

			if (Array.isArray(stepDef)) {
				// alt step group — find any article_quiz alt not yet submitted
				const existingAlts = (progress[idx] as QuestStepProgressEntry[] | undefined) ?? [];
				const completedAltIndices = new Set(existingAlts.map((e) => e.altIndex ?? 0));

				for (let altIdx = 0; altIdx < stepDef.length; altIdx++) {
					const alt = stepDef[altIdx];
					if (alt.type !== 'article_quiz') continue;
					if (completedAltIndices.has(altIdx)) continue;

					const [requiredActivityType, scoreThreshold] = alt.parameters;
					const normalizedThreshold = normalizeThreshold(scoreThreshold, 'Article quiz');

					if (!normalizedThreshold.ok) continue;
					if (!articleTypes.includes(requiredActivityType)) continue;
					if (scorePercent < normalizedThreshold.value * 100) continue;

					matchedStepIndex = idx;
					matchedAltIndex = altIdx;
					matchedStepDef = alt;
					thresholdPercent = normalizedThreshold.value * 100;
					break;
				}
			} else {
				// normal step — only the current step is eligible; past ones are already completed
				if (idx !== currentStepIndex) continue;
				if (stepDef.type !== 'article_quiz') continue;

				const [requiredActivityType, scoreThreshold] = stepDef.parameters;
				const normalizedThreshold = normalizeThreshold(scoreThreshold, 'Article quiz');

				if (!normalizedThreshold.ok) continue;
				if (!articleTypes.includes(requiredActivityType)) continue;
				if (scorePercent < normalizedThreshold.value * 100) continue;

				matchedStepIndex = idx;
				matchedStepDef = stepDef;
				thresholdPercent = normalizedThreshold.value * 100;
			}

			if (matchedStepIndex !== null) break;
		}

		if (matchedStepIndex === null || matchedStepDef === null) {
			console.log(
				`handleQuizQuestStep: no matching article_quiz step found for user ${userId} on quest "${currentQuest.title}" ` +
					`with types [${articleTypes.join(', ')}] and score ${scorePercent}% (step ${currentStepIndex}), skipping`
			);
			return { handled: false };
		}

		const questResponse: QuestStepResponse = {
			type: 'article_quiz',
			index: matchedStepIndex,
			altIndex: matchedAltIndex,
			scoreKey,
			score: Math.round(scorePercent)
		};

		const deviceMetadata: QuestDeviceMetadata = {
			make: 'unknown',
			model: 'API',
			os: 'web'
		};

		const questResult = await updateQuestProgress(
			userId,
			questResponse,
			deviceMetadata,
			bindings,
			ctx
		);

		// send notifications
		const stepDesc = matchedStepDef.description;
		ctx.waitUntil(
			(async () => {
				if (!questResult.completed) {
					await sendUserNotification(
						bindings,
						userId,
						`Progress on Quest "${currentQuest.title}"`,
						`Step completed: ${stepDesc}`,
						undefined,
						'info',
						'quest'
					);
				}
			})()
		);

		console.log(
			`handleQuizQuestStep: auto-handled article_quiz step for user ${userId} on quest "${currentQuest.title}" ` +
				`step ${matchedStepIndex}${matchedAltIndex !== undefined ? ` alt ${matchedAltIndex}` : ''} ` +
				`with score ${scorePercent}% (threshold: ${thresholdPercent}%) - completed: ${questResult.completed}`
		);
		return { handled: true, completed: questResult.completed, message: questResult.message };
	} catch (err) {
		console.error(
			`handleQuizQuestStep: error auto-handling article_quiz quest step for user ${userId}:`,
			err
		);
		// Don't throw - let quiz submission succeed even if quest handling fails
		return { handled: false };
	}
}
