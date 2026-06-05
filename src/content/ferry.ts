// ferry - user content grading

import { Buffer } from 'node:buffer';
import { Bindings } from '../util/types';
import { streamToUint8Array } from '../util/util';

const embedModel = '@cf/baai/bge-m3';
const imageClassificationModel = '@cf/microsoft/resnet-50';
const objectDetectionModel = '@cf/facebook/detr-resnet-50';
const imageCaptionModel = '@cf/llava-hf/llava-1.5-7b-hf';
const audioTranscriptionModel = '@cf/openai/whisper-large-v3-turbo';

// images larger than this must be downscaled to be passed to workers AI
const AI_IMAGE_MAX_DIMENSION = 1024;
const AI_IMAGE_JPEG_QUALITY = 85;

// downscaling threshold for AI scoring; under this size downscaling is not necessary
const AI_IMAGE_DOWNSCALE_THRESHOLD = AI_IMAGE_MAX_DIMENSION * AI_IMAGE_MAX_DIMENSION * 4; // 4 bytes per pixel for RGBA input

export async function downscaleImageForAI(env: Bindings, image: Uint8Array): Promise<Uint8Array> {
	if (image.length <= AI_IMAGE_DOWNSCALE_THRESHOLD) return image;

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(image);
			controller.close();
		}
	});

	try {
		const transformed = (
			await env.IMAGES.input(stream)
				.transform({
					width: AI_IMAGE_MAX_DIMENSION,
					height: AI_IMAGE_MAX_DIMENSION,
					fit: 'scale-down'
				})
				.output({ format: 'image/jpeg', quality: AI_IMAGE_JPEG_QUALITY })
		).image();

		const downscaled = await streamToUint8Array(transformed);
		// fall back to the original if the transform produced nothing usable
		return downscaled.length > 0 ? downscaled : image;
	} catch (err) {
		// scoring should not hard-fail on a transform error; the original bytes may already be
		// small enough, and if not the ai call surfaces its own error
		console.error('Failed to downscale image for AI scoring; using original bytes', {
			inputBytes: image.length,
			err
		});
		return image;
	}
}

export interface ScoringCriterion {
	id: string;
	weight: number; // must sum to 1.0
	ideal: string;
}

export interface CriterionResult {
	id: string; // matches criterion id (e.x. "relevance", "creativity", etc)
	similarity: number; // raw cosine similarity (-1.0 to 1.0)
	normalized: number; // normalized similarity (0.0 to 1.0)
	weighted: number; // weighted contribution to final score (0.0 to weight)
}

export interface ScoreResult {
	score: number; // 0.0 - 1.0
	breakdown: CriterionResult[];
}

async function embedTexts(env: Bindings, texts: string[]): Promise<number[][]> {
	const result = new Array<number[] | null>(texts.length).fill(null);
	const missingIndices: number[] = [];
	const missingTexts: string[] = [];

	await Promise.all(
		texts.map(async (text, i) => {
			const cached = await env.CACHE.get<number[]>(`embedding:text:${hashText(text)}`, 'json');
			if (cached) {
				result[i] = cached;
			} else {
				missingIndices.push(i);
				missingTexts.push(text);
			}
		})
	);

	if (missingTexts.length === 0) {
		return result as number[][];
	}

	const response = (await env.AI.run(embedModel, {
		text: missingTexts,
		pooling: 'cls'
	})) as Ai_Cf_Baai_Bge_M3_Output_Embedding;

	const data = response?.data;
	if (!data || data.length !== missingTexts.length) {
		throw new Error('Batch embedding failed');
	}

	await Promise.all(
		missingTexts.map((text, i) => {
			const embedding = data[i];
			result[missingIndices[i]] = embedding;
			return env.CACHE.put(`embedding:text:${hashText(text)}`, JSON.stringify(embedding), {
				expirationTtl: 60 * 60 * 12
			}).catch((err) => {
				console.error('Failed to cache batched embedding:', err);
			});
		})
	);

	return result as number[][];
}

// use a smooth mapping from cosine similarity [-1, 1] -> [0, 1] to avoid
// hard clipping artifacts that can create left/right score skew
function normalizeSimilarity(sim: number): number {
	if (!Number.isFinite(sim)) return 0;
	return Math.min(1, Math.max(0, (sim + 1) / 2));
}

function hashText(text: string): string {
	// 32-bit FNV-1a hash to avoid cache key collisions on shared prefixes
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, '0');
}

function cosineSimilarity(a: number[], b: number[]): number {
	let dot = 0;
	let normA = 0;
	let normB = 0;

	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}

	return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export async function scoreText(
	env: Bindings,
	text: string,
	rubric: ScoringCriterion[]
): Promise<ScoreResult> {
	if (!rubric.length) {
		throw new Error('Rubric must not be empty');
	}

	const totalWeight = rubric.reduce((s, r) => s + r.weight, 0);
	if (Math.abs(totalWeight - 1.0) > 0.001) {
		throw new Error('Rubric weights must sum to 1.0');
	}

	// Embed the user text and every rubric ideal in a single batched AI call.
	// bge-m3 accepts an array input, so this is one network round-trip per scoring instead of N+1.
	const allEmbeddings = await embedTexts(env, [text, ...rubric.map((c) => c.ideal)]);
	const embedding = allEmbeddings[0];
	const idealEmbeddings = allEmbeddings.slice(1);

	let score = 0;
	const breakdown: CriterionResult[] = [];

	for (let i = 0; i < rubric.length; i++) {
		const criterion = rubric[i];
		const ideal = idealEmbeddings[i];

		const similarity = cosineSimilarity(embedding, ideal);

		const normalized = normalizeSimilarity(similarity);
		const weighted = normalized * criterion.weight;

		score += weighted;

		breakdown.push({
			id: criterion.id,
			similarity,
			normalized,
			weighted
		});
	}

	return { score, breakdown };
}

export async function scoreImage(
	env: Bindings,
	image: Uint8Array,
	prompt: string,
	rubric: ScoringCriterion[]
): Promise<[string, ScoreResult]> {
	const scaled = await downscaleImageForAI(env, image);

	// caption, score
	const caption = await env.AI.run(imageCaptionModel, {
		image: [...new Uint8Array(scaled)],
		prompt,
		// Caption prompts cap output at ~150 words; 2048 was ~10× excess and billed accordingly.
		max_tokens: 512
	});

	const text = caption?.description?.trim();
	if (!text) {
		throw new Error('Image captioning failed');
	}

	return [text, await scoreText(env, text, rubric)];
}

export async function scoreAudio(
	env: Bindings,
	audio: Uint8Array,
	prompt: string,
	rubric: ScoringCriterion[]
): Promise<[string, ScoreResult]> {
	const base64 = Buffer.from(audio).toString('base64');

	// transcript, score
	const transcript = await env.AI.run(audioTranscriptionModel, {
		audio: base64,
		// Pin English so Whisper skips language auto-detect and uses VAD to skip silence,
		// both reduce billed neurons for the same accuracy on quest audio.
		language: 'en',
		vad_filter: true
	});

	const text = transcript?.text?.trim();
	if (!text) {
		throw new Error('Audio transcription failed');
	}

	return [text, await scoreText(env, text, rubric)];
}

export async function classifyImage(
	env: Bindings,
	image: Uint8Array
): Promise<{ label: string; confidence: number }[]> {
	const scaled = await downscaleImageForAI(env, image);
	const response = (await env.AI.run(imageClassificationModel, {
		image: [...new Uint8Array(scaled)]
	})) as AiImageClassificationOutput;

	return (
		response
			.filter((r) => r.score != null && r.label) // filter out invalid results
			.filter((r) => r.score! > 0.01)
			// take primary label (before first comma) to normalize multi-name imagenet labels e.g. "ant, emmet, pismire" -> "ant"
			.map((r) => ({
				label: r.label!.split(',')[0].trim().toLowerCase().replace(/\s+/g, '_'),
				confidence: r.score!
			}))
	);
}

export async function detectObjects(
	env: Bindings,
	image: Uint8Array
): Promise<{ label: string; confidence: number; box: [number, number, number, number] }[]> {
	const scaled = await downscaleImageForAI(env, image);
	const response = (await env.AI.run(objectDetectionModel as any, {
		image: [...new Uint8Array(scaled)]
	})) as
		| AiObjectDetectionOutput
		| {
				result?: {
					label?: string;
					score?: number;
					box?: { xmin: number; ymin: number; xmax: number; ymax: number };
				}[];
		  };

	const legacyResults =
		typeof response === 'object' && response && !Array.isArray(response)
			? (response as { result?: unknown[] }).result
			: undefined;

	const normalizedResults: {
		label?: string;
		score?: number;
		box?: { xmin: number; ymin: number; xmax: number; ymax: number };
	}[] = (Array.isArray(response) ? response : legacyResults || []).map((r) => r || {});

	return (
		normalizedResults
			.filter((r) => r.score != null && r.label) // filter out invalid results
			.filter((r) => r.score! > 0.01)
			// take primary label (before first comma) to normalize multi-name coco labels
			.map((r) => ({
				label: r.label!.split(',')[0].trim().toLowerCase().replace(/\s+/g, '_'),
				confidence: r.score!,
				box: r.box ? [r.box.xmin, r.box.ymin, r.box.xmax, r.box.ymax] : [0, 0, 0, 0]
			}))
	);
}
