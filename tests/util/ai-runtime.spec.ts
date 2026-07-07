import { describe, expect, it, vi } from 'vitest';
import {
	runAI,
	AITimeoutError,
	AIUnavailableError,
	extractAIText,
	parseAIJson
} from '../../src/util/ai-runtime';

describe('runAI', () => {
	it('returns the value on the first successful attempt', async () => {
		const fn = vi.fn(async () => 'ok');
		const result = await runAI('t', fn, { attempts: 3 });
		expect(result).toBe('ok');
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it('retries a transient failure and then succeeds', async () => {
		let calls = 0;
		const fn = vi.fn(async () => {
			calls++;
			if (calls < 2) throw new Error('transient 5xx');
			return 'recovered';
		});

		const result = await runAI('t', fn, { attempts: 3, backoffMs: 1 });
		expect(result).toBe('recovered');
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it('throws AIUnavailableError after exhausting attempts on persistent errors', async () => {
		const fn = vi.fn(async () => {
			throw new Error('always down');
		});

		await expect(runAI('t', fn, { attempts: 3, backoffMs: 1 })).rejects.toBeInstanceOf(
			AIUnavailableError
		);
		expect(fn).toHaveBeenCalledTimes(3);
	});

	it('retries an unusable (non-throwing) result via shouldRetryResult', async () => {
		let calls = 0;
		const fn = vi.fn(async () => {
			calls++;
			return calls < 3 ? { response: '' } : { response: 'good' };
		});

		const result = await runAI<{ response: string }>('t', fn, {
			attempts: 3,
			backoffMs: 1,
			shouldRetryResult: (v) => !(v as { response?: string })?.response
		});
		expect(result.response).toBe('good');
		expect(fn).toHaveBeenCalledTimes(3);
	});

	it('times out a hung attempt and surfaces AITimeoutError once the budget is spent', async () => {
		// never resolves; the timeout must fire so the client is not left hanging
		const fn = vi.fn(() => new Promise<string>(() => {}));

		await expect(
			runAI('t', fn, { attempts: 2, perAttemptTimeoutMs: 20, totalTimeoutMs: 60, backoffMs: 1 })
		).rejects.toBeInstanceOf(AITimeoutError);
	});

	it('recovers when a hung first attempt times out but the retry is fast', async () => {
		let calls = 0;
		const fn = vi.fn(() => {
			calls++;
			if (calls === 1) return new Promise<string>(() => {}); // hangs -> times out
			return Promise.resolve('fast');
		});

		const result = await runAI('t', fn, {
			attempts: 3,
			perAttemptTimeoutMs: 20,
			totalTimeoutMs: 500,
			backoffMs: 1
		});
		expect(result).toBe('fast');
		expect(calls).toBe(2);
	});
});

describe('extractAIText', () => {
	it('reads the top-level .response shape', () => {
		expect(extractAIText({ response: 'hello' })).toBe('hello');
	});

	it('reads the chat-completions choices[0].message.content shape', () => {
		expect(extractAIText({ choices: [{ message: { content: 'world' } }] })).toBe('world');
	});

	it('reads the gpt-oss output[].content[].text shape', () => {
		expect(extractAIText({ output: [{ content: [{ type: 'output_text', text: 'deep' }] }] })).toBe(
			'deep'
		);
	});

	it('reads nested .result.response, whisper .text, and llava .description', () => {
		expect(extractAIText({ result: { response: 'nested' } })).toBe('nested');
		expect(extractAIText({ text: 'transcript' })).toBe('transcript');
		expect(extractAIText({ description: 'caption' })).toBe('caption');
	});

	it('passes through a raw string and returns empty for junk', () => {
		expect(extractAIText('plain')).toBe('plain');
		expect(extractAIText(null)).toBe('');
		expect(extractAIText(42)).toBe('');
		expect(extractAIText({})).toBe('');
	});
});

describe('parseAIJson', () => {
	it('parses a json string', () => {
		expect(parseAIJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
	});

	it('parses json wrapped in a markdown code fence', () => {
		expect(parseAIJson('```json\n{"a":2}\n```')).toEqual({ a: 2 });
	});

	it('parses json out of either workers-ai shape', () => {
		expect(parseAIJson({ response: '{"a":3}' })).toEqual({ a: 3 });
		expect(parseAIJson({ choices: [{ message: { content: '{"a":4}' } }] })).toEqual({ a: 4 });
	});

	it('recovers an embedded object when the model adds prose around it', () => {
		expect(parseAIJson('here you go: {"a":5} thanks')).toEqual({ a: 5 });
	});

	it('returns an already-parsed object untouched', () => {
		expect(parseAIJson({ questions: [] })).toEqual({ questions: [] });
	});

	it('returns null for empty or garbage output', () => {
		expect(parseAIJson('')).toBeNull();
		expect(parseAIJson('not json at all')).toBeNull();
		expect(parseAIJson(null)).toBeNull();
	});
});
