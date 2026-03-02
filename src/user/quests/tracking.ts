import { HTTPException } from 'hono/http-exception';
import { quests, QuestStep } from '.';
import { Bindings } from '../../util/types';
import { deflate, encrypt, inflate, decrypt, normalizeId } from '../../util/util';
import { addImpactPoints } from '../points';
import { tryCache } from '../../util/cache';
import { QuestDeviceMetadata, validateStep } from './validation';

export type QuestProgress = {
	questId: string;
	currentStep: number; // index of the current step the user is on
	completed: boolean;
	startedAt?: number; // unix ms when the quest was started
};

// used during request handling - contains actual binary data for ai validation
export type QuestStepResponse = { type: QuestStep['type']; index: number; altIndex?: number } & (
	| {
			type:
				| 'take_photo_location'
				| 'take_photo_classification'
				| 'take_photo_caption'
				| 'draw_picture'
				| 'take_photo_objects';
			data: Uint8Array;
	  }
	| { type: 'attend_event'; eventId: string; timestamp: number }
	| { type: 'transcribe_audio'; data: Uint8Array }
	| {
			type: 'article_quiz';
			scoreKey: string; // key to look up the user's quiz score for this article in KV
			score: number;
	  }
	| { type: 'match_terms' | 'order_items' } // validated externally via separate endpoints
);

// stored in kv - binary data is replaced with an r2 bucket key
export type QuestStepProgressEntry = {
	type: QuestStep['type'];
	index: number;
	altIndex?: number;
	submittedAt: number; // unix ms when this step was submitted
} & (
	| {
			type:
				| 'take_photo_location'
				| 'take_photo_classification'
				| 'take_photo_caption'
				| 'draw_picture'
				| 'take_photo_objects';
			r2Key: string;
	  }
	| { type: 'attend_event'; eventId: string; timestamp: number }
	| { type: 'transcribe_audio'; r2Key: string }
	| { type: 'article_quiz'; scoreKey: string; score: number }
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

// convert a QuestStepResponse (with binary) to a QuestStepProgressEntry (with r2 key)
async function toProgressEntry(
	response: QuestStepResponse,
	userId: string,
	questId: string,
	submittedAt: number,
	bindings: Bindings
): Promise<QuestStepProgressEntry> {
	const altIdx = response.altIndex ?? 0;

	if (
		response.type === 'take_photo_location' ||
		response.type === 'take_photo_classification' ||
		response.type === 'take_photo_caption' ||
		response.type === 'draw_picture' ||
		response.type === 'take_photo_objects'
	) {
		const r2Key = stepR2Key(userId, questId, response.index, altIdx);
		await uploadStepData(response.data, r2Key, bindings);
		const entry: QuestStepProgressEntry = {
			type: response.type,
			index: response.index,
			altIndex: response.altIndex,
			submittedAt,
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

	// attend_event, article_quiz, match_terms, order_items have no binary payload
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

	// kv stores r2 path + completion time as a small json value (no large payload)
	const completedAt = Date.now();
	await bindings.KV.put(
		`user:quest_history:${userId}:${questId}`,
		JSON.stringify({ r2Key, completedAt }),
		{ metadata: { questId, completedAt } }
	);

	// update the history index
	const indexKey = `user:quest_history_index:${userId}`;
	const existing = (await bindings.KV.get<string[]>(indexKey, 'json')) || [];
	if (!existing.includes(questId)) {
		await bindings.KV.put(indexKey, JSON.stringify([...existing, questId]));
	}
}

export async function getCurrentQuestProgress(userId: string, bindings: Bindings) {
	const userId0 = normalizeId(userId);
	// progress entries are QuestStepProgressEntry for normal steps, QuestStepProgressEntry[] for alt steps
	const res = await bindings.KV.getWithMetadata<
		(QuestStepProgressEntry | QuestStepProgressEntry[])[],
		QuestProgress
	>(`user:quest_progress:${userId0}`, 'json');

	const quest = res.metadata?.questId
		? quests.find((q) => q.id === res.metadata?.questId) || null
		: null;

	return {
		progress: res.value || [],
		quest,
		questId: res.metadata?.questId || null,
		currentStep:
			quest && res.metadata?.currentStep !== undefined
				? quest.steps[res.metadata.currentStep] || null
				: null,
		currentStepIndex: res.metadata?.currentStep || 0,
		completed: res.metadata?.completed || false
	};
}

// get the list of completed quest IDs for a user
export async function getQuestHistory(userId: string, bindings: Bindings): Promise<string[]> {
	const userId0 = normalizeId(userId);
	return (await bindings.KV.get<string[]>(`user:quest_history_index:${userId0}`, 'json')) || [];
}

// get the full progress for a completed quest - r2 read is cached for 1 hour (immutable)
export async function getCompletedQuestProgress(
	userId: string,
	questId: string,
	bindings: Bindings
) {
	const userId0 = normalizeId(userId);

	// read r2 key + completion time from kv
	const res = await bindings.KV.get<{ r2Key: string; completedAt: number }>(
		`user:quest_history:${userId0}:${questId}`,
		'json'
	);
	if (!res) return null;

	const { r2Key, completedAt } = res;

	// cache the r2 download (the expensive part) since the archive is immutable
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
			const quest = quests.find((q) => q.id === questId) || null;
			return { progress, quest, questId, completedAt };
		},
		60 * 60
	);
}

// starts a new quest - cleans up r2 data for unfinished quests, preserves completed history
export async function startQuest(userId: string, questId: string, bindings: Bindings) {
	const userId0 = normalizeId(userId);

	// check for existing quest and clean up r2 if it was unfinished (not yet archived)
	const existing = await bindings.KV.getWithMetadata<
		(QuestStepProgressEntry | QuestStepProgressEntry[])[],
		QuestProgress
	>(`user:quest_progress:${userId0}`, 'json');

	if (existing.metadata && !existing.metadata.completed && existing.value?.length) {
		// unfinished: binary data was never archived, delete from r2
		await cleanupR2(existing.value, bindings);
	}

	await bindings.KV.put(`user:quest_progress:${userId0}`, JSON.stringify([]), {
		metadata: { questId, currentStep: 0, completed: false, startedAt: Date.now() }
	});
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
}

export async function updateQuestProgress(
	userId: string,
	stepResponse: QuestStepResponse,
	device: QuestDeviceMetadata,
	bindings: Bindings,
	ctx: ExecutionContext
) {
	const userId0 = normalizeId(userId);
	const res = await bindings.KV.getWithMetadata<
		(QuestStepProgressEntry | QuestStepProgressEntry[])[],
		QuestProgress
	>(`user:quest_progress:${userId0}`, 'json');

	const progress = res.value || [];
	const metadata = res.metadata || {
		currentStep: 0,
		questId: null,
		completed: false,
		startedAt: undefined
	};

	// ignore if quest already completed
	if (metadata.completed) {
		throw new HTTPException(409, { message: 'Quest already completed' });
	}

	const quest = quests.find((q) => q.id === metadata.questId);
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
	// the unlock time is delay seconds after the first completion of the previous step
	// (or quest startedAt for the very first step).
	const submittingStepDef = isAltStep
		? (targetStepDef as QuestStep[])[stepResponse.altIndex ?? 0]
		: (targetStepDef as QuestStep);
	if (submittingStepDef?.delay && idx === metadata.currentStep) {
		let baseTime: number;
		if (idx === 0) {
			// no previous step — measure from quest start
			baseTime = metadata.startedAt ?? 0;
		} else {
			// measure from the first submission of the previous step
			const prevEntry = progress[idx - 1];
			if (Array.isArray(prevEntry)) {
				baseTime = (prevEntry as QuestStepProgressEntry[])[0]?.submittedAt ?? 0;
			} else {
				baseTime = (prevEntry as QuestStepProgressEntry)?.submittedAt ?? 0;
			}
		}
		const availableAt = baseTime + submittingStepDef.delay * 1000;
		const now = Date.now();
		if (now < availableAt) {
			const secondsRemaining = Math.ceil((availableAt - now) / 1000);
			throw new HTTPException(425, {
				message: `Step not yet available. Try again in ${secondsRemaining} second${secondsRemaining === 1 ? '' : 's'}.`
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

	// validate step response against step requirements (uses binary data for ai models)
	const validation = await validateStep(submittingStep, stepResponse, bindings, device);
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
		bindings
	);

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

	ctx.waitUntil(
		Promise.all([
			// write updated progress to kv
			bindings.KV.put(`user:quest_progress:${userId0}`, JSON.stringify(updatedProgress), {
				metadata: { questId: metadata.questId, currentStep: newStepIndex, completed }
			}),
			// archive to history when quest is completed (immutable, r2 keys preserved)
			completed
				? archiveCompletedQuest(userId0, quest.id, updatedProgress, bindings)
				: Promise.resolve(),
			// award step reward and/or quest completion points
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
				}
			})()
		])
	);

	return { completed, message: validation.message };
}
