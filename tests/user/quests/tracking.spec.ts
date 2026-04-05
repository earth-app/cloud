import { describe, expect, it, vi } from 'vitest';
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
	startQuest
} from '../../../src/user/quests/tracking';
import { createMockBindings } from '../../helpers/mock-bindings';
import { MockKVNamespace } from '../../helpers/mock-kv';

describe('downloadStepData', () => {
	it('returns null when r2 object does not exist', async () => {
		const bindings = createMockBindings();
		const data = await downloadStepData('missing.bin', bindings);
		expect(data).toBeNull();
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
});

describe('checkStepDelay', () => {
	it('returns available=true when there is no active quest', async () => {
		const bindings = createMockBindings({ KV: new MockKVNamespace() as any });
		const status = await checkStepDelay('1', 0, 0, bindings);
		expect(status).toEqual({ available: true });
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

	it('safely no-ops archive recovery when no completed active quest exists', async () => {
		const bindings = createMockBindings({ KV: new MockKVNamespace() as any });
		const ctx = { waitUntil: vi.fn((promise: Promise<unknown>) => void promise) };
		await expect(maybeArchiveCompletedQuest('9', bindings, ctx as any)).resolves.toBeUndefined();
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
});
