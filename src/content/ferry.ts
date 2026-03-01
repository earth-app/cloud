// ferry - user content grading

import { Buffer } from 'node:buffer';
import { tryCache } from '../util/cache';
import { Bindings } from '../util/types';

const embedModel = '@cf/baai/bge-m3';
const imageClassificationModel = '@cf/microsoft/resnet-50';
const objectDetectionModel = '@cf/facebook/detr-resnet-50';
const imageCaptionModel = '@cf/llava-hf/llava-1.5-7b-hf';
const audioTranscriptionModel = '@cf/openai/whisper-large-v3-turbo';

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

async function embedText(env: Bindings, text: string): Promise<number[]> {
	return tryCache(`embedding:text:${text.substring(0, 100)}`, env.CACHE, async () => {
		const response = (await env.AI.run(embedModel, {
			text
		})) as Ai_Cf_Baai_Bge_M3_Ouput_Embedding;

		if (!response?.data || response.data.length === 0) {
			throw new Error('Embedding failed');
		}

		return response.data[0];
	});
}

const MIN_SIM = 0.25;
const MAX_SIM = 0.6;

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

function normalizeSimilarity(sim: number): number {
	return Math.min(1, Math.max(0, (sim - MIN_SIM) / (MAX_SIM - MIN_SIM)));
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

	// Generate embedding for user text
	const embedding = await embedText(env, text);

	// Pre-compute all ideal embeddings in parallel for efficiency
	const idealEmbeddings = await Promise.all(
		rubric.map((criterion) => embedText(env, criterion.ideal))
	);

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
	// caption, score
	const caption = await env.AI.run(imageCaptionModel, {
		image: [...new Uint8Array(image)],
		prompt,
		max_tokens: 2048
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
		initial_prompt: prompt
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
	const response = await env.AI.run(imageClassificationModel, {
		image: [...new Uint8Array(image)]
	});

	return (
		response
			.filter((r) => r.score && r.label) // filter out invalid results
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
	const response = await env.AI.run(objectDetectionModel as any, {
		image: [...new Uint8Array(image)]
	});

	const results: {
		label?: string;
		score?: number;
		box?: { xmin: number; ymin: number; xmax: number; ymax: number };
	}[] = response.result || [];

	return (
		results
			.filter((r) => r.score && r.label && r.box) // filter out invalid results
			.filter((r) => r.score! > 0.01)
			// take primary label (before first comma) to normalize multi-name coco labels
			.map((r) => ({
				label: r.label!.split(',')[0].trim().toLowerCase().replace(/\s+/g, '_'),
				confidence: r.score!,
				box: [r.box!.xmin, r.box!.ymin, r.box!.xmax, r.box!.ymax]
			}))
	);
}
