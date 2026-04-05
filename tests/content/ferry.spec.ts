import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	classifyImage,
	detectObjects,
	scoreAudio,
	scoreImage,
	scoreText,
	type ScoringCriterion
} from '../../src/content/ferry';
import { env } from 'cloudflare:workers';
import { type Bindings } from '../../src/util/types';

function createBindings(aiRun: ReturnType<typeof vi.fn>): Bindings {
	return {
		...env,
		NCBI_API_KEY: 'ncbi',
		AI: { run: aiRun } as unknown as Ai
	} as unknown as Bindings;
}

afterEach(() => {
	vi.restoreAllMocks();
});

const rubric: ScoringCriterion[] = [
	{ id: 'relevance', weight: 0.5, ideal: 'relevant and precise' },
	{ id: 'clarity', weight: 0.5, ideal: 'clear and concise' }
];

describe('scoreText', () => {
	it('throws when rubric is empty', async () => {
		const bindings = createBindings(vi.fn());
		await expect(scoreText(bindings, 'text', [])).rejects.toThrow('Rubric must not be empty');
	});

	it('throws when rubric weights do not sum to 1', async () => {
		const bindings = createBindings(vi.fn());
		await expect(
			scoreText(bindings, 'text', [{ id: 'only', weight: 0.2, ideal: 'ideal' }])
		).rejects.toThrow('Rubric weights must sum to 1.0');
	});

	it('returns score and criterion breakdown for valid embeddings', async () => {
		const aiRun = vi.fn(async (_model: string, input: { text: string }) => {
			if (input.text.includes('relevant')) {
				return { data: [[0.9, 0.1, 0.1]] };
			}
			if (input.text.includes('clear')) {
				return { data: [[0.8, 0.2, 0.1]] };
			}
			return { data: [[1, 0, 0]] };
		});
		const bindings = createBindings(aiRun);

		const result = await scoreText(bindings, 'user response text', rubric);
		expect(result.breakdown).toHaveLength(2);
		expect(result.score).toBeGreaterThanOrEqual(0);
		expect(result.score).toBeLessThanOrEqual(1);
	});
});

describe('scoreImage', () => {
	it('throws when caption model does not produce description', async () => {
		const aiRun = vi.fn(async () => ({}));
		const bindings = createBindings(aiRun);
		await expect(scoreImage(bindings, new Uint8Array([1, 2]), 'prompt', rubric)).rejects.toThrow(
			'Image captioning failed'
		);
	});
});

describe('scoreAudio', () => {
	it('throws when transcription model does not produce text', async () => {
		const aiRun = vi.fn(async () => ({}));
		const bindings = createBindings(aiRun);
		await expect(scoreAudio(bindings, new Uint8Array([1, 2]), 'prompt', rubric)).rejects.toThrow(
			'Audio transcription failed'
		);
	});
});

describe('classifyImage', () => {
	it('normalizes labels and filters low-confidence entries', async () => {
		const aiRun = vi.fn(async () => [
			{ label: 'ant, emmet, pismire', score: 0.91 },
			{ label: 'noise', score: 0.001 }
		]);
		const bindings = createBindings(aiRun);
		const result = await classifyImage(bindings, new Uint8Array([1, 2]));

		expect(result).toEqual([{ label: 'ant', confidence: 0.91 }]);
	});
});

describe('detectObjects', () => {
	it('normalizes detection output with box coordinates', async () => {
		const aiRun = vi.fn(async () => ({
			result: [
				{ label: 'traffic light, signal', score: 0.8, box: { xmin: 1, ymin: 2, xmax: 3, ymax: 4 } },
				{ label: 'low', score: 0.001, box: { xmin: 0, ymin: 0, xmax: 0, ymax: 0 } }
			]
		}));
		const bindings = createBindings(aiRun);
		const result = await detectObjects(bindings, new Uint8Array([1]));

		expect(result).toEqual([{ label: 'traffic_light', confidence: 0.8, box: [1, 2, 3, 4] }]);
	});
});
