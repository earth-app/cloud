import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/user/notifications', () => ({
	sendUserNotification: vi.fn(async () => undefined)
}));

import {
	checkStepDelay,
	downloadStepData,
	enrichProgressEntries,
	getCompletedQuestProgress,
	getCurrentQuestProgress,
	getQuestHistory,
	handleQuizQuestStep,
	maybeArchiveCompletedQuest,
	resetQuestProgress,
	startQuest,
	updateQuestProgress
} from '../../../src/user/quests/tracking';
import { createMockBindings } from '../../helpers/mock-bindings';
import { MockKVNamespace } from '../../helpers/mock-kv';
import { deflate, encrypt } from '../../../src/util/util';

async function putEncryptedObject(
	bindings: ReturnType<typeof createMockBindings>,
	key: string,
	data: Uint8Array
) {
	const compressed = await deflate(data);
	const encryptedData = await encrypt(compressed, bindings.ENCRYPTION_KEY);
	await bindings.R2.put(key, encryptedData);
}

function createWaitUntilCollector() {
	const pending: Promise<unknown>[] = [];
	const ctx = {
		waitUntil: (promise: Promise<unknown>) => {
			pending.push(Promise.resolve(promise));
		}
	};

	return {
		ctx,
		flush: async () => {
			await Promise.all(pending);
		}
	};
}

describe('downloadStepData', () => {
	it('returns null when r2 object does not exist', async () => {
		const bindings = createMockBindings();
		const data = await downloadStepData('missing.bin', bindings);
		expect(data).toBeNull();
	});

	it('decrypts and returns stored binary payloads', async () => {
		const bindings = createMockBindings();
		const expected = new Uint8Array([73, 68, 51, 1, 2, 3, 4]);
		await putEncryptedObject(bindings, 'audio.bin', expected);

		const data = await downloadStepData('audio.bin', bindings);
		expect(data).toEqual(expected);
	});
});

describe('enrichProgressEntries', () => {
	it('keeps non-binary entries unchanged', async () => {
		const bindings = createMockBindings();
		const entries = [
			{ type: 'article_quiz', index: 0, scoreKey: 'x', score: 90, submittedAt: 1 } as any
		];
		const enriched = await enrichProgressEntries(entries, bindings);
		expect(enriched).toEqual(entries);
	});

	it('enriches binary entries with the expected data URL MIME prefixes', async () => {
		const bindings = createMockBindings();

		await Promise.all([
			putEncryptedObject(bindings, 'jpg.bin', new Uint8Array([0xff, 0xd8, 0xff, 0xdb])),
			putEncryptedObject(bindings, 'png.bin', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2])),
			putEncryptedObject(
				bindings,
				'webp.bin',
				new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])
			),
			putEncryptedObject(bindings, 'mp3.bin', new Uint8Array([0x49, 0x44, 0x33, 0, 1])),
			putEncryptedObject(
				bindings,
				'wav.bin',
				new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45])
			),
			putEncryptedObject(bindings, 'caf.bin', new Uint8Array([0x63, 0x61, 0x66, 0x66, 0])),
			putEncryptedObject(bindings, 'audio.bin', new Uint8Array([1, 2, 3, 4]))
		]);

		const entries = [
			{ type: 'take_photo_classification', index: 0, submittedAt: 1, r2Key: 'jpg.bin' },
			{ type: 'draw_picture', index: 1, submittedAt: 1, r2Key: 'png.bin' },
			{ type: 'take_photo_objects', index: 2, submittedAt: 1, r2Key: 'webp.bin' },
			{ type: 'transcribe_audio', index: 3, submittedAt: 1, r2Key: 'mp3.bin' },
			[
				{ type: 'transcribe_audio', index: 4, altIndex: 0, submittedAt: 1, r2Key: 'wav.bin' },
				{ type: 'transcribe_audio', index: 4, altIndex: 1, submittedAt: 1, r2Key: 'caf.bin' },
				{ type: 'transcribe_audio', index: 4, altIndex: 2, submittedAt: 1, r2Key: 'audio.bin' }
			],
			{ type: 'article_quiz', index: 5, submittedAt: 1, scoreKey: 'k', score: 95 }
		] as any;

		const enriched = await enrichProgressEntries(entries, bindings);
		expect((enriched[0] as any).data.startsWith('data:image/jpeg;base64,')).toBe(true);
		expect((enriched[1] as any).data.startsWith('data:image/png;base64,')).toBe(true);
		expect((enriched[2] as any).data.startsWith('data:image/webp;base64,')).toBe(true);
		expect((enriched[3] as any).data.startsWith('data:audio/mpeg;base64,')).toBe(true);
		expect((enriched[4] as any)[0].data.startsWith('data:audio/wav;base64,')).toBe(true);
		expect((enriched[4] as any)[1].data.startsWith('data:audio/x-caf;base64,')).toBe(true);
		expect((enriched[4] as any)[2].data.startsWith('data:audio/octet-stream;base64,')).toBe(true);
		expect((enriched[5] as any).data).toBeUndefined();
	});
});

describe('checkStepDelay', () => {
	it('returns available=true when there is no active quest', async () => {
		const bindings = createMockBindings({ KV: new MockKVNamespace() as any });
		const status = await checkStepDelay('1', 0, 0, bindings);
		expect(status).toEqual({ available: true });
	});

	it('returns available=false with remaining time for delayed steps', async () => {
		const kv = new MockKVNamespace();
		const now = Date.now();
		const progress = [] as any[];
		progress[3] = {
			type: 'article_quiz',
			index: 3,
			scoreKey: 'quiz:key',
			score: 90,
			submittedAt: now
		};

		await kv.put('user:quest_progress:77', JSON.stringify(progress), {
			metadata: {
				questId: 'vegetable_head',
				currentStep: 4,
				completed: false,
				startedAt: now
			}
		});

		const bindings = createMockBindings({ KV: kv as any });
		const status = await checkStepDelay('77', 4, 0, bindings);

		expect(status.available).toBe(false);
		expect(status.secondsRemaining).toBeGreaterThan(0);
		expect(status.availableAt).toBeGreaterThan(now);
	});

	it('returns available=true for unknown quests or missing step definitions', async () => {
		const kv = new MockKVNamespace();
		await kv.put('user:quest_progress:123', JSON.stringify([]), {
			metadata: {
				questId: 'unknown_quest',
				currentStep: 0,
				completed: false,
				startedAt: Date.now()
			}
		});

		const bindings = createMockBindings({ KV: kv as any });
		expect(await checkStepDelay('123', 0, 0, bindings)).toEqual({ available: true });

		await kv.put('user:quest_progress:124', JSON.stringify([]), {
			metadata: {
				questId: 'fun_facts',
				currentStep: 99,
				completed: false,
				startedAt: Date.now()
			}
		});

		expect(await checkStepDelay('124', 99, 0, bindings)).toEqual({ available: true });
	});

	it('uses previous alternative step completion time for delayed unlock checks', async () => {
		const kv = new MockKVNamespace();
		const oldSubmission = Date.now() - 1300 * 1000;

		await kv.put(
			'user:quest_progress:88',
			JSON.stringify([
				[
					{
						type: 'take_photo_objects',
						index: 0,
						altIndex: 0,
						submittedAt: oldSubmission,
						r2Key: 'x'
					}
				]
			]),
			{
				metadata: {
					questId: 'my_aesthetic',
					currentStep: 1,
					completed: false,
					startedAt: oldSubmission
				}
			}
		);

		const bindings = createMockBindings({ KV: kv as any });
		const status = await checkStepDelay('88', 1, 0, bindings);
		expect(status).toEqual({ available: true });
	});
});

describe('updateQuestProgress', () => {
	it('throws when quest progress metadata is marked completed', async () => {
		const kv = new MockKVNamespace();
		await kv.put('user:quest_progress:1', JSON.stringify([]), {
			metadata: {
				questId: 'fun_facts',
				currentStep: 0,
				completed: true,
				startedAt: Date.now()
			}
		});

		const bindings = createMockBindings({ KV: kv as any });
		await expect(
			updateQuestProgress(
				'1',
				{ type: 'article_quiz', index: 0, scoreKey: 'k', score: 100 },
				{ make: 'unknown', model: 'API', os: 'web' },
				bindings,
				{ waitUntil: () => {} } as any
			)
		).rejects.toMatchObject({ status: 409 });
	});

	it('throws when there is no active quest metadata', async () => {
		const bindings = createMockBindings({ KV: new MockKVNamespace() as any });
		await expect(
			updateQuestProgress(
				'2',
				{ type: 'article_quiz', index: 0, scoreKey: 'k', score: 100 },
				{ make: 'unknown', model: 'API', os: 'web' },
				bindings,
				{ waitUntil: () => {} } as any
			)
		).rejects.toMatchObject({ status: 404 });
	});

	it('throws for future step indices and delay-gated submissions', async () => {
		const kv = new MockKVNamespace();
		const bindings = createMockBindings({ KV: kv as any });

		await startQuest('3', 'fun_facts', bindings);
		await expect(
			updateQuestProgress(
				'3',
				{ type: 'order_items', index: 2 },
				{ make: 'unknown', model: 'API', os: 'web' },
				bindings,
				{ waitUntil: () => {} } as any
			)
		).rejects.toMatchObject({ status: 400 });

		const now = Date.now();
		const delayedProgress = [] as any[];
		delayedProgress[3] = {
			type: 'take_photo_classification',
			index: 3,
			submittedAt: now,
			r2Key: 'previous.bin'
		};

		await kv.put('user:quest_progress:4', JSON.stringify(delayedProgress), {
			metadata: {
				questId: 'vegetable_head',
				currentStep: 4,
				completed: false,
				startedAt: now
			}
		});

		await expect(
			updateQuestProgress(
				'4',
				{ type: 'order_items', index: 4 },
				{ make: 'unknown', model: 'API', os: 'web' },
				bindings,
				{ waitUntil: () => {} } as any
			)
		).rejects.toMatchObject({ status: 425 });
	});

	it('rejects invalid or duplicate alternative step submissions', async () => {
		const kv = new MockKVNamespace();
		const bindings = createMockBindings({ KV: kv as any });

		await kv.put('user:quest_progress:5', JSON.stringify([]), {
			metadata: {
				questId: 'vegetable_head',
				currentStep: 5,
				completed: false,
				startedAt: Date.now() - 100_000
			}
		});

		await expect(
			updateQuestProgress(
				'5',
				{ type: 'take_photo_classification', index: 5, altIndex: 99, data: new Uint8Array([1]) },
				{ make: 'unknown', model: 'API', os: 'web' },
				bindings,
				{ waitUntil: () => {} } as any
			)
		).rejects.toMatchObject({ status: 404 });

		await kv.put(
			'user:quest_progress:6',
			JSON.stringify([
				,
				,
				,
				,
				,
				[
					{
						type: 'take_photo_classification',
						index: 5,
						altIndex: 0,
						submittedAt: Date.now() - 10,
						r2Key: 'existing.bin'
					}
				]
			]),
			{
				metadata: {
					questId: 'vegetable_head',
					currentStep: 5,
					completed: false,
					startedAt: Date.now() - 100_000
				}
			}
		);

		await expect(
			updateQuestProgress(
				'6',
				{ type: 'take_photo_classification', index: 5, altIndex: 0, data: new Uint8Array([2]) },
				{ make: 'unknown', model: 'API', os: 'web' },
				bindings,
				{ waitUntil: () => {} } as any
			)
		).rejects.toMatchObject({ status: 409 });
	});

	it('rejects duplicate normal step submissions and validation failures', async () => {
		const kv = new MockKVNamespace();
		const bindings = createMockBindings({ KV: kv as any });

		await kv.put(
			'user:quest_progress:7',
			JSON.stringify([
				,
				{
					type: 'article_quiz',
					index: 1,
					submittedAt: Date.now() - 10,
					scoreKey: 'old:key',
					score: 100
				}
			]),
			{
				metadata: {
					questId: 'fun_facts',
					currentStep: 1,
					completed: false,
					startedAt: Date.now() - 100_000
				}
			}
		);

		await expect(
			updateQuestProgress(
				'7',
				{ type: 'article_quiz', index: 1, scoreKey: 'new:key', score: 100 },
				{ make: 'unknown', model: 'API', os: 'web' },
				bindings,
				{ waitUntil: () => {} } as any
			)
		).rejects.toMatchObject({ status: 409 });

		await kv.put('user:quest_progress:8', JSON.stringify([]), {
			metadata: {
				questId: 'fun_facts',
				currentStep: 0,
				completed: false,
				startedAt: Date.now() - 100_000
			}
		});

		await expect(
			updateQuestProgress(
				'8',
				{ type: 'order_items', index: 0 },
				{ make: 'unknown', model: 'API', os: 'web' },
				bindings,
				{ waitUntil: () => {} } as any
			)
		).rejects.toMatchObject({ status: 400 });
	});

	it('properly handles first step quiz progress updates', async () => {
		const kv = new MockKVNamespace();
		const bindings = createMockBindings({ KV: kv as any });

		await kv.put('user:quest_progress:9', JSON.stringify([]), {
			metadata: {
				questId: 'fun_facts',
				currentStep: 0,
				completed: false,
				startedAt: Date.now() - 100_000
			}
		});
		await kv.put(
			'article:quiz_score:9:100',
			JSON.stringify({ score: 10, scorePercent: 100, total: 10 })
		);

		const result = await updateQuestProgress(
			'9',
			{ type: 'article_quiz', index: 0, scoreKey: 'article:quiz_score:9:100', score: 100 },
			{ make: 'unknown', model: 'API', os: 'web' },
			bindings,
			{ waitUntil: () => {} } as any
		);

		expect(result.completed).toBe(false);
		const progress = await getCurrentQuestProgress('9', bindings);
		expect(progress.currentStepIndex).toBe(1);
		expect(progress.progress[0]).toMatchObject({
			type: 'article_quiz',
			index: 0,
			scoreKey: 'article:quiz_score:9:100',
			score: 100
		});
	});

	it('persists successful progress updates and archives completed quests', async () => {
		const kv = new MockKVNamespace();
		const cache = new MockKVNamespace();
		const bindings = createMockBindings({ KV: kv as any, CACHE: cache as any });

		await kv.put('user:quest_progress:77', JSON.stringify([]), {
			metadata: {
				questId: 'fun_facts',
				currentStep: 0,
				completed: false,
				startedAt: Date.now() - 100_000
			}
		});
		await kv.put(
			'article:quiz_score:77:100',
			JSON.stringify({ score: 9, scorePercent: 90, total: 10 })
		);

		const first = createWaitUntilCollector();
		const firstResult = await updateQuestProgress(
			'77',
			{ type: 'article_quiz', index: 0, scoreKey: 'article:quiz_score:77:100', score: 90 },
			{ make: 'unknown', model: 'API', os: 'web' },
			bindings,
			first.ctx as any
		);
		await first.flush();

		expect(firstResult.completed).toBe(false);
		const mid = await getCurrentQuestProgress('77', bindings);
		expect(mid.currentStepIndex).toBe(1);

		const priorSteps = [
			{
				type: 'article_quiz',
				index: 0,
				scoreKey: 'k0',
				score: 100,
				submittedAt: Date.now() - 2000
			},
			{
				type: 'article_quiz',
				index: 1,
				scoreKey: 'k1',
				score: 100,
				submittedAt: Date.now() - 1500
			},
			[
				{
					type: 'draw_picture',
					index: 2,
					altIndex: 0,
					submittedAt: Date.now() - 1200,
					r2Key: 'users/77/quests/fun_facts/step_2_0.bin'
				}
			],
			{
				type: 'take_photo_caption',
				index: 3,
				submittedAt: Date.now() - 900,
				r2Key: 'users/77/quests/fun_facts/step_3_0.bin',
				score: 0.9,
				prompt: 'innovation'
			},
			{ type: 'order_items', index: 4, submittedAt: Date.now() - 500 }
		] as any;

		await kv.put('user:quest_progress:77', JSON.stringify(priorSteps), {
			metadata: {
				questId: 'fun_facts',
				currentStep: 5,
				completed: false,
				startedAt: Date.now() - 100_000
			}
		});
		await kv.put(
			'article:quiz_score:77:200',
			JSON.stringify({ score: 10, scorePercent: 100, total: 10 })
		);

		const completion = createWaitUntilCollector();
		const completionResult = await updateQuestProgress(
			'77',
			{ type: 'article_quiz', index: 5, scoreKey: 'article:quiz_score:77:200', score: 100 },
			{ make: 'unknown', model: 'API', os: 'web' },
			bindings,
			completion.ctx as any
		);
		await completion.flush();

		expect(completionResult.completed).toBe(true);
		expect(await kv.get('user:quest_progress:77')).toBeNull();
		expect(await getQuestHistory('77', bindings)).toContain('fun_facts');
		expect((bindings.R2 as any).has('users/77/quests/fun_facts/history.bin')).toBe(true);
	});
});

describe('quest lifecycle helpers', () => {
	it('starts and resets active quest progress', async () => {
		const kv = new MockKVNamespace();
		const bindings = createMockBindings({ KV: kv as any });

		await startQuest('101', 'vegetable_head', bindings);
		const current = await getCurrentQuestProgress('101', bindings);
		expect(current.questId).toBe('vegetable_head');
		expect(current.completed).toBe(false);

		await resetQuestProgress('101', bindings);
		const afterReset = await getCurrentQuestProgress('101', bindings);
		expect(afterReset.questId).toBeNull();
		expect(afterReset.progress).toEqual([]);
	});

	it('returns empty history and null completed payload when nothing archived', async () => {
		const bindings = createMockBindings({
			KV: new MockKVNamespace() as any,
			CACHE: new MockKVNamespace() as any
		});
		expect(await getQuestHistory('202', bindings)).toEqual([]);
		expect(await getCompletedQuestProgress('202', 'vegetable_head', bindings)).toBeNull();
	});

	it('rejects starting a quest that is already in history', async () => {
		const kv = new MockKVNamespace();
		await kv.put('user:quest_history_index:808', JSON.stringify(['vegetable_head']));
		const bindings = createMockBindings({ KV: kv as any });

		await expect(startQuest('808', 'vegetable_head', bindings)).rejects.toMatchObject({
			status: 409
		});
	});

	it('cleans up unfinished active quest R2 payloads when starting a new quest', async () => {
		const kv = new MockKVNamespace();
		const bindings = createMockBindings({ KV: kv as any });

		const oldR2Key = 'users/11/quests/vegetable_head/step_0_0.bin';
		await bindings.R2.put(oldR2Key, new Uint8Array([1, 2, 3]));

		await kv.put(
			'user:quest_progress:11',
			JSON.stringify([
				{
					type: 'take_photo_classification',
					index: 0,
					submittedAt: Date.now(),
					r2Key: oldR2Key
				}
			]),
			{
				metadata: {
					questId: 'vegetable_head',
					currentStep: 1,
					completed: false,
					startedAt: Date.now()
				}
			}
		);

		await startQuest('11', 'fun_facts', bindings);

		expect((bindings.R2 as any).has(oldR2Key)).toBe(false);
		const current = await getCurrentQuestProgress('11', bindings);
		expect(current.questId).toBe('fun_facts');
		expect(current.currentStepIndex).toBe(0);
	});

	it('safely no-ops archive recovery when no completed active quest exists', async () => {
		const bindings = createMockBindings({ KV: new MockKVNamespace() as any });
		const ctx = { waitUntil: vi.fn((promise: Promise<unknown>) => void promise) };
		await expect(maybeArchiveCompletedQuest('9', bindings, ctx as any)).resolves.toBeUndefined();
	});

	it('archives completed quest progress and exposes it via history APIs', async () => {
		const kv = new MockKVNamespace();
		const cache = new MockKVNamespace();
		const bindings = createMockBindings({ KV: kv as any, CACHE: cache as any });

		await kv.put(
			'user:quest_progress:909',
			JSON.stringify([
				{ type: 'article_quiz', index: 0, submittedAt: Date.now(), scoreKey: 'k', score: 90 }
			]),
			{
				metadata: {
					questId: 'fun_facts',
					currentStep: 2,
					completed: true,
					startedAt: Date.now() - 10_000
				}
			}
		);

		await maybeArchiveCompletedQuest('909', bindings);

		expect(await kv.get('user:quest_progress:909')).toBeNull();
		expect(await getQuestHistory('909', bindings)).toContain('fun_facts');

		const archived = await getCompletedQuestProgress('909', 'fun_facts', bindings);
		expect(archived).not.toBeNull();
		expect(archived?.questId).toBe('fun_facts');
		expect(Array.isArray(archived?.progress)).toBe(true);
	});
});

describe('handleQuizQuestStep', () => {
	it('returns handled=false when article types are missing', async () => {
		const bindings = createMockBindings({ KV: new MockKVNamespace() as any });
		const result = await handleQuizQuestStep(
			'303',
			'article:quiz_score:303:1',
			95,
			undefined,
			bindings,
			{ waitUntil: () => {} } as any
		);
		expect(result).toEqual({ handled: false });
	});

	it('returns handled=false when no active quest exists', async () => {
		const bindings = createMockBindings({ KV: new MockKVNamespace() as any });
		const result = await handleQuizQuestStep(
			'404',
			'article:quiz_score:404:1',
			95,
			['HOME_IMPROVEMENT' as any],
			bindings,
			{ waitUntil: () => {} } as any
		);
		expect(result).toEqual({ handled: false });
	});

	it('auto-progresses matching article_quiz steps for active quests', async () => {
		const kv = new MockKVNamespace();
		const bindings = createMockBindings({ KV: kv as any });
		const pending: Promise<unknown>[] = [];
		const ctx = {
			waitUntil: (promise: Promise<unknown>) => {
				pending.push(Promise.resolve(promise));
			}
		};

		await startQuest('505', 'fun_facts', bindings);
		await kv.put(
			'article:quiz_score:505:100',
			JSON.stringify({ score: 9, scorePercent: 90, total: 10 })
		);

		const result = await handleQuizQuestStep(
			'505',
			'article:quiz_score:505:100',
			90,
			['HOME_IMPROVEMENT' as any],
			bindings,
			ctx as any
		);

		await Promise.all(pending);

		expect(result.handled).toBe(true);

		const current = await getCurrentQuestProgress('505', bindings);
		expect(current.questId).toBe('fun_facts');
		expect(current.currentStepIndex).toBeGreaterThanOrEqual(1);
		expect(current.progress[0]).toMatchObject({ type: 'article_quiz' });
	});

	it('returns handled=false when active quest is already completed', async () => {
		const kv = new MockKVNamespace();
		await kv.put('user:quest_progress:700', JSON.stringify([]), {
			metadata: {
				questId: 'fun_facts',
				currentStep: 5,
				completed: true,
				startedAt: Date.now() - 10_000
			}
		});

		const bindings = createMockBindings({ KV: kv as any });
		const result = await handleQuizQuestStep(
			'700',
			'article:quiz_score:700:100',
			100,
			['HEALTH' as any],
			bindings,
			{ waitUntil: () => {} } as any
		);

		expect(result).toEqual({ handled: false });
	});

	it('returns handled=false when no current article quiz step matches the submitted score', async () => {
		const kv = new MockKVNamespace();
		const bindings = createMockBindings({ KV: kv as any });
		await startQuest('701', 'fun_facts', bindings);

		const result = await handleQuizQuestStep(
			'701',
			'article:quiz_score:701:1',
			70,
			['ART' as any],
			bindings,
			{ waitUntil: () => {} } as any
		);

		expect(result).toEqual({ handled: false });
	});

	it('returns handled=false when quest auto-handling throws unexpectedly', async () => {
		const bindings = createMockBindings();
		(bindings.KV as any).getWithMetadata = vi.fn(async () => {
			throw new Error('kv unavailable');
		});

		const result = await handleQuizQuestStep(
			'702',
			'article:quiz_score:702:1',
			100,
			['HOME_IMPROVEMENT' as any],
			bindings,
			{ waitUntil: () => {} } as any
		);

		expect(result).toEqual({ handled: false });
	});
});
