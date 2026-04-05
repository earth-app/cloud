import { describe, expect, it } from 'vitest';
import { validateStep } from '../../../src/user/quests/validation';
import { createMockBindings } from '../../helpers/mock-bindings';
import { MockKVNamespace } from '../../helpers/mock-kv';

describe('validateStep', () => {
	it('rejects response type mismatch', async () => {
		const step = {
			type: 'article_quiz',
			description: 'Read and pass',
			parameters: ['ART', 0.8]
		} as any;

		const response = { type: 'order_items', index: 0 } as any;
		const result = await validateStep(step, response, createMockBindings(), {
			make: 'unknown',
			model: 'unknown',
			os: 'unknown'
		});

		expect(result.success).toBe(false);
		expect(result.message).toContain('Expected response type');
	});

	it('rejects article quiz when score key is missing', async () => {
		const bindings = createMockBindings({ KV: new MockKVNamespace() as any });
		const step = {
			type: 'article_quiz',
			description: 'Read and pass',
			parameters: ['ART', 0.8]
		} as any;
		const response = {
			type: 'article_quiz',
			index: 0,
			scoreKey: 'missing',
			score: 90
		} as any;

		const result = await validateStep(step, response, bindings, {
			make: 'unknown',
			model: 'unknown',
			os: 'unknown'
		});

		expect(result.success).toBe(false);
		expect(result.message).toContain('Quiz score not found');
	});

	it('accepts article quiz when persisted score exceeds threshold', async () => {
		const kv = new MockKVNamespace();
		await kv.put('score:ok', JSON.stringify({ score: 8, scorePercent: 90, total: 10 }));
		const bindings = createMockBindings({ KV: kv as any });
		const step = {
			type: 'article_quiz',
			description: 'Read and pass',
			parameters: ['ART', 0.8]
		} as any;
		const response = {
			type: 'article_quiz',
			index: 0,
			scoreKey: 'score:ok',
			score: 90
		} as any;

		const result = await validateStep(step, response, bindings, {
			make: 'unknown',
			model: 'unknown',
			os: 'unknown'
		});

		expect(result.success).toBe(true);
	});

	it('returns success for externally validated attend_event steps', async () => {
		const step = {
			type: 'attend_event',
			description: 'Attend event',
			parameters: [{ type: 'activity_type', value: 'NATURE' }, 10]
		} as any;
		const response = {
			type: 'attend_event',
			index: 0,
			eventId: '100',
			timestamp: Date.now()
		} as any;

		const result = await validateStep(step, response, createMockBindings(), {
			make: 'unknown',
			model: 'unknown',
			os: 'unknown'
		});
		expect(result.success).toBe(true);
	});

	it('rejects transcribe_audio when binary data is missing', async () => {
		const step = {
			type: 'transcribe_audio',
			description: 'Speak about topic',
			parameters: ['topic', 0.7]
		} as any;
		const response = {
			type: 'transcribe_audio',
			index: 0,
			data: undefined
		} as any;

		const result = await validateStep(step, response, createMockBindings(), {
			make: 'unknown',
			model: 'unknown',
			os: 'unknown'
		});
		expect(result.success).toBe(false);
		expect(result.message).toContain('No audio data provided');
	});
});
