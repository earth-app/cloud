import { QuestStep } from '.';
import { classifyImage, detectObjects, scoreAudio, scoreImage } from '../../content/ferry';
import ExifReader from 'exifreader';
import { isInsideLocation } from '../../util/util';
import { Bindings } from '../../util/types';
import { QuestStepResponse } from './tracking';

export type QuestDeviceMetadata = {
	latitude?: number;
	longitude?: number;
	make: 'apple' | 'samsung' | 'google' | string;
	model: string;
	[other: string]: any; // allow for additional metadata fields as needed
};

// main validation function

export async function validateStep(
	step: QuestStep,
	response: QuestStepResponse,
	bindings: Bindings,
	data: QuestDeviceMetadata
): Promise<{ success: boolean; message?: string }> {
	if (step.type !== response.type) {
		return { success: false, message: `Expected response type ${step.type}, got ${response.type}` };
	}

	switch (response.type) {
		case 'take_photo_location':
		case 'take_photo_classification':
		case 'take_photo_caption':
		case 'draw_picture':
		case 'take_photo_objects': {
			if (!response.data) {
				return { success: false, message: 'No photo data provided in response.' };
			}

			return await validateStepPhoto(step, response.data, bindings, data);
		}
		case 'transcribe_audio': {
			if (!response.data) {
				return { success: false, message: 'No audio data provided in response.' };
			}

			return await validateStepAudio(step, response.data, bindings);
		}
		case 'article_quiz': {
			return await validateArticleQuiz(step, response, bindings);
		}
	}

	return { success: true }; // attend_event, match_terms, order_items are validated externally
}

// validation functions

async function validateArticleQuiz(
	step: QuestStep,
	response: QuestStepResponse & { type: 'article_quiz' },
	bindings: Bindings
) {
	if (step.type !== 'article_quiz') {
		return { success: false, message: `Expected article_quiz step, got ${step.type}` };
	}

	// look up the persisted quiz score from kv to avoid trusting the client
	const quizData = await bindings.KV.get<{
		score: number;
		scorePercent: number;
		total: number;
	}>(response.scoreKey, 'json');

	if (!quizData) {
		return {
			success: false,
			message: 'Quiz score not found. Please complete the article quiz first.'
		};
	}

	const [, threshold] = step.parameters;
	const requiredPercent = threshold * 100;

	if (quizData.scorePercent < requiredPercent) {
		return {
			success: false,
			message: `Quiz score ${quizData.scorePercent.toFixed(1)}% does not meet the required ${requiredPercent}%.`
		};
	}

	return { success: true };
}

async function validateStepAudio(step: QuestStep, audio: Uint8Array, bindings: Bindings) {
	if (step.type !== 'transcribe_audio') {
		return {
			success: false,
			message: `Expected audio response for transcribe_audio step, got ${step.type}`
		};
	}

	const [prompt, threshold] = step.parameters;
	const [_, score] = await scoreAudio(bindings, audio, prompt, [
		{
			id: 'relevance',
			weight: 0.7,
			ideal: 'Audio is relevant to the prompt and demonstrates understanding'
		},
		{
			id: 'clarity',
			weight: 0.3,
			ideal: 'Audio is clear and intelligible'
		}
	]);

	if (score.score < threshold) {
		return {
			success: false,
			message: `Audio does not meet the required score threshold of ${threshold}. Got ${score.score}.`
		};
	}

	return { success: true };
}

async function validateStepPhoto(
	step: QuestStep,
	image: Uint8Array,
	bindings: Bindings,
	data: QuestDeviceMetadata
) {
	const metadata = ExifReader.load(image.buffer);

	// global validation
	const make = metadata.Make?.value.toString();
	if (make && make !== data.make) {
		return { success: false, message: `Expected device make ${data.make}, got ${make}` };
	}

	const model = metadata.Model?.value.toString();
	if (model && model !== data.model) {
		return {
			success: false,
			message: `Expected device model ${data.model}, got ${model}`
		};
	}

	const now = Date.now(); // in utc milliseconds
	// exif datetime format is "YYYY:MM:DD HH:MM:SS" - normalize to iso-parseable format
	const dateTaken = metadata.DateTimeOriginal
		? new Date(
				metadata.DateTimeOriginal.value.toString().replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3')
			).getTime()
		: null; // in timezone-based milliseconds

	const offset = metadata.OffsetTimeOriginal ? metadata.OffsetTimeOriginal.value.toString() : null; // offset from UTC in format ±HH:MM, e.g. -07:00
	const [offsetHours, offsetMinutes] = offset?.split(':', 2).map(Number) || [0, 0];
	const offsetMs = (offsetHours * 60 + offsetMinutes) * 60 * 1000;

	/// allow 5 minute clock skew
	if (dateTaken && Math.abs(now - dateTaken + offsetMs) > 5 * 60 * 1000) {
		return {
			success: false,
			message: 'Photo timestamp is not within acceptable range (possible clock skew or old photo).'
		};
	}

	// type-based validation
	if (step.type === 'take_photo_location' || step.type === 'take_photo_classification') {
		let label: string | undefined;
		let score: number | undefined;
		if (step.type === 'take_photo_location') {
			// validate both device GPS data and photo EXIF GPS data
			const [lat, lng, radius, label0, score0] = step.parameters;

			if (!data.latitude || !data.longitude) {
				return {
					success: false,
					message: 'No GPS data provided in device metadata.'
				};
			}

			if (!isInsideLocation([data.latitude, data.longitude], [lat, lng], radius)) {
				return {
					success: false,
					message: 'Device was not within the required location radius when photo was taken.'
				};
			}

			const latitude = Number(metadata.GPSLatitude?.value?.toString() || '0');
			const longitude = Number(metadata.GPSLongitude?.value?.toString() || '0');

			if (!latitude || !longitude) {
				return { success: false, message: 'No GPS data found in photo EXIF metadata.' };
			}

			if (!isInsideLocation([latitude, longitude], [lat, lng], radius)) {
				return {
					success: false,
					message: 'Photo was not taken within the required location radius.'
				};
			}

			label = label0;
			score = score0;
		}

		if (step.type === 'take_photo_classification') {
			const [label0, score0] = step.parameters;
			label = label0;
			score = score0;
		}

		if (label && score) {
			const classifications = await classifyImage(bindings, image);
			const classification = classifications.find((c) => c.label === label);

			if (!classification || classification.confidence < score) {
				return {
					success: false,
					message: `Photo does not meet the required classification label "${label}" with confidence ${score}.`
				};
			}
		}
	}

	if (step.type === 'take_photo_objects') {
		const labelsAndScores = step.parameters;
		const detections = await detectObjects(bindings, image);

		for (const [label, score] of labelsAndScores) {
			const detection = detections.find(
				(d) =>
					d.label.toLowerCase().replace(/\s+/g, '_') === label.toLowerCase().replace(/\s+/g, '_')
			);
			if (!detection || detection.confidence < score) {
				return {
					success: false,
					message: `Photo does not contain the required object "${label}" with confidence ${score}.`
				};
			}
		}
	}

	if (step.type === 'take_photo_caption') {
		const [criteria, prompt, threshold] = step.parameters;
		const [_, score] = await scoreImage(bindings, image, prompt, criteria);
		if (score.score < threshold) {
			return {
				success: false,
				message: `Photo caption does not meet the required score threshold of ${threshold}. Got ${score.score}.`
			};
		}
	}

	if (step.type === 'draw_picture') {
		const [prompt, threshold] = step.parameters;

		// ask the model to describe what is drawn so we can score accuracy against the prompt
		const captionPrompt = 'Describe the main object or subject that is drawn in this image.';
		const [_, score] = await scoreImage(bindings, image, captionPrompt, [
			{
				id: 'accuracy',
				weight: 0.7,
				ideal: `The image clearly shows a drawing of a ${prompt}`
			},
			{
				id: 'effort',
				weight: 0.3,
				ideal: 'The drawing shows recognizable detail and clear intent in depicting the subject'
			}
		]);
		if (score.score < threshold) {
			return {
				success: false,
				message: `Drawing does not meet the required score threshold of ${threshold}. Got ${score.score.toFixed(2)}.`
			};
		}
	}

	return { success: true };
}
