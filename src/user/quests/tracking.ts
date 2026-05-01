import { Buffer } from 'node:buffer';
import { HTTPException } from 'hono/http-exception';
import { quests, QuestStep } from '.';
import { ActivityType, Bindings, ExecutionCtxLike } from '../../util/types';
import { deflate, encrypt, inflate, decrypt, normalizeId } from '../../util/util';
import { addImpactPoints } from '../points';
import { sendUserNotification } from '../notifications';
import { tryCache } from '../../util/cache';
import { normalizeThreshold, QuestDeviceMetadata, validateStep } from './validation';

export type QuestProgress = {
	questId: string;
	currentStep: number; // index of the current step the user is on
	completed: boolean; // whether the quest has been completed
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
				| 'take_photo_objects'
				| 'take_photo_validation'
				| 'take_photo_list';
			data: Uint8Array;
	  }
	| {
			type: 'attend_event';
			eventId: string;
			timestamp: number; // unix ms when the event was attended
	  }
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
				| 'take_photo_objects'
				| 'take_photo_validation'
				| 'take_photo_list';
			score?: number; // validation score (e.g. confidence) for this step submission, if applicable
			prompt?: string; // generated prompt from take_photo_caption
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
	prompt?: string
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

	// remove the active progress key — quest is now immutably in history
	await bindings.KV.delete(`user:quest_progress:${userId}`);
}

export async function checkStepDelay(
	userId: string,
	stepIndex: number,
	altIndex: number | undefined,
	bindings: Bindings
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

	const quest = quests.find((q) => q.id === metadata.questId);
	if (!quest) return { available: true };

	const targetStepDef = quest.steps[stepIndex];
	if (!targetStepDef) return { available: true };

	const isAltStep = Array.isArray(targetStepDef);
	const stepDef = isAltStep
		? (targetStepDef as QuestStep[])[altIndex ?? 0]
		: (targetStepDef as QuestStep);

	if (!stepDef?.delay) return { available: true };

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

	const availableAt = baseTime + stepDef.delay * 1000;
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

	const quest = quests.find((q) => q.id === res.metadata!.questId) || null;
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

	await bindings.KV.put(`user:quest_progress:${userId0}`, JSON.stringify([]), {
		metadata: { questId, currentStep: 0, completed: false, startedAt: Date.now() }
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

export async function updateQuestProgress(
	userId: string,
	stepResponse: QuestStepResponse,
	device: QuestDeviceMetadata,
	bindings: Bindings,
	ctx: ExecutionCtxLike
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
	if (idx === metadata.currentStep) {
		const delayStatus = await checkStepDelay(userId, idx, stepResponse.altIndex, bindings);
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
		bindings,
		validation.score,
		validation.prompt
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

	await bindings.KV.put(`user:quest_progress:${userId0}`, JSON.stringify(updatedProgress), {
		metadata: { questId: metadata.questId, currentStep: newStepIndex, completed }
	});

	console.log(
		`User ${userId} submitted step ${idx}${isAltStep ? ` alt ${stepResponse.altIndex}` : ''} for quest "${quest.title}" - validation: ${validation.success}, completed: ${completed}`
	);

	ctx.waitUntil(
		Promise.all([
			// archive to history when quest is completed (immutable, r2 keys preserved)
			completed
				? archiveCompletedQuest(userId0, quest.id, updatedProgress, bindings)
				: Promise.resolve(),
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
