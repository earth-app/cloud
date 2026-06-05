import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	classifyImage,
	detectObjects,
	downscaleImageForAI,
	scoreAudio,
	scoreImage,
	scoreText,
	type ScoringCriterion
} from '../../src/content/ferry';
import { env } from 'cloudflare:workers';
import { type Bindings } from '../../src/util/types';

function createBindings(aiRun: ReturnType<typeof vi.fn>, images?: unknown): Bindings {
	return {
		...env,
		NCBI_API_KEY: 'ncbi',
		AI: { run: aiRun } as unknown as Ai,
		...(images ? { IMAGES: images as ImagesBinding } : {})
	} as unknown as Bindings;
}

// controllable IMAGES mock that records the transform/output options and emits `transformed`
// from output().image(); set `throwOnInput` to simulate a failing transform
function mockImages(transformed: Uint8Array, opts: { throwOnInput?: boolean } = {}) {
	const calls = { transform: [] as unknown[], output: [] as unknown[] };
	const binding = {
		input: (_stream: ReadableStream) => {
			if (opts.throwOnInput) throw new Error('transform failed');
			return {
				transform: (t: unknown) => {
					calls.transform.push(t);
					return {
						output: (o: unknown) => {
							calls.output.push(o);
							return Promise.resolve({
								image: () =>
									new ReadableStream<Uint8Array>({
										start(controller) {
											controller.enqueue(transformed);
											controller.close();
										}
									})
							});
						}
					};
				}
			};
		}
	};
	return { binding, calls };
}

afterEach(() => {
	vi.restoreAllMocks();
});

const rubric: ScoringCriterion[] = [
	{ id: 'relevance', weight: 0.5, ideal: 'relevant and precise' },
	{ id: 'clarity', weight: 0.5, ideal: 'clear and concise' }
];

// over the downscale threshold (1024*1024*4 bytes), so the transform path actually runs
const bigImage = () => new Uint8Array(5 * 1024 * 1024);

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
		// scoreText now batches the user text and every rubric `ideal` into a single bge-m3
		// call with `text: string[]`. The mock returns one embedding per input.
		const embedOne = (text: string): number[] => {
			if (text.includes('relevant')) return [0.9, 0.1, 0.1];
			if (text.includes('clear')) return [0.8, 0.2, 0.1];
			return [1, 0, 0];
		};
		const aiRun = vi.fn(async (_model: string, input: { text: string | string[] }) => {
			const texts = Array.isArray(input.text) ? input.text : [input.text];
			return { data: texts.map(embedOne) };
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
	it('normalizes array output and provides fallback boxes when absent', async () => {
		const aiRun = vi.fn(async () => [
			{ label: 'traffic light, signal', score: 0.8 },
			{ label: 'low', score: 0.001 }
		]);
		const bindings = createBindings(aiRun);
		const result = await detectObjects(bindings, new Uint8Array([1]));

		expect(result).toEqual([{ label: 'traffic_light', confidence: 0.8, box: [0, 0, 0, 0] }]);
	});

	it('supports legacy object detection responses with a result field and coordinates', async () => {
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

describe('downscaleImageForAI', () => {
	it('downscales to a bounded scale-down JPEG', async () => {
		const out = new Uint8Array([9, 9, 9]);
		const { binding, calls } = mockImages(out);
		const bindings = createBindings(vi.fn(), binding);

		const result = await downscaleImageForAI(bindings, bigImage());

		expect(result).toEqual(out);
		expect(calls.transform[0]).toMatchObject({ fit: 'scale-down' });
		expect(calls.output[0]).toMatchObject({ format: 'image/jpeg' });
	});

	it('skips the transform for images already under the threshold (saves credits)', async () => {
		const { binding, calls } = mockImages(new Uint8Array([9, 9, 9]));
		const bindings = createBindings(vi.fn(), binding);
		const small = new Uint8Array(50_000);

		const result = await downscaleImageForAI(bindings, small);

		expect(result).toBe(small);
		expect(calls.transform).toHaveLength(0);
	});

	it('returns empty input untouched without invoking the binding', async () => {
		const { binding, calls } = mockImages(new Uint8Array([1]));
		const bindings = createBindings(vi.fn(), binding);

		const result = await downscaleImageForAI(bindings, new Uint8Array());

		expect(result).toEqual(new Uint8Array());
		expect(calls.transform).toHaveLength(0);
	});

	it('falls back to the original bytes when the transform throws', async () => {
		const { binding } = mockImages(new Uint8Array([9]), { throwOnInput: true });
		const bindings = createBindings(vi.fn(), binding);
		const original = bigImage();

		const result = await downscaleImageForAI(bindings, original);

		expect(result).toBe(original);
	});

	it('falls back to the original bytes when the transform yields an empty image', async () => {
		const { binding } = mockImages(new Uint8Array());
		const bindings = createBindings(vi.fn(), binding);
		const original = bigImage();

		const result = await downscaleImageForAI(bindings, original);

		expect(result).toBe(original);
	});
});

describe('image scoring downscales before inference', () => {
	// the vision models receive the image as an int array, so assert they get the *downscaled* bytes
	it('scoreImage captions the downscaled image', async () => {
		const downscaled = new Uint8Array([7, 7, 7]);
		const { binding } = mockImages(downscaled);
		let capturedImage: number[] | undefined;
		const aiRun = vi.fn(
			async (_model: string, input: { image?: number[]; text?: string | string[] }) => {
				if (input.image) {
					capturedImage = input.image;
					return { description: 'a cat' };
				}
				const texts = Array.isArray(input.text) ? input.text : [input.text!];
				return { data: texts.map(() => [1, 0, 0]) };
			}
		);
		const bindings = createBindings(aiRun, binding);

		await scoreImage(bindings, bigImage(), 'prompt', rubric);

		expect(capturedImage).toEqual([7, 7, 7]);
	});

	it('classifyImage classifies the downscaled image', async () => {
		const downscaled = new Uint8Array([5, 6]);
		const { binding } = mockImages(downscaled);
		let capturedImage: number[] | undefined;
		const aiRun = vi.fn(async (_model: string, input: { image?: number[] }) => {
			capturedImage = input.image;
			return [{ label: 'cat', score: 0.9 }];
		});
		const bindings = createBindings(aiRun, binding);

		await classifyImage(bindings, bigImage());

		expect(capturedImage).toEqual([5, 6]);
	});

	it('detectObjects detects on the downscaled image', async () => {
		const downscaled = new Uint8Array([3, 4]);
		const { binding } = mockImages(downscaled);
		let capturedImage: number[] | undefined;
		const aiRun = vi.fn(async (_model: string, input: { image?: number[] }) => {
			capturedImage = input.image;
			return [{ label: 'cat', score: 0.9 }];
		});
		const bindings = createBindings(aiRun, binding);

		await detectObjects(bindings, bigImage());

		expect(capturedImage).toEqual([3, 4]);
	});
});
