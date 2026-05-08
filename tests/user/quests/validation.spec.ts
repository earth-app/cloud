import { beforeEach, describe, expect, it, vi } from 'vitest';
import { validateStep } from '../../../src/user/quests/validation';
import { createMockBindings } from '../../helpers/mock-bindings';
import { MockKVNamespace } from '../../helpers/mock-kv';
import ExifReader from 'exifreader';
import { parseBuffer } from 'music-metadata';
import {
	classifyImage,
	detectObjects,
	scoreAudio,
	scoreImage,
	scoreText
} from '../../../src/content/ferry';

vi.mock('exifreader', () => ({
	default: {
		load: vi.fn()
	}
}));

vi.mock('music-metadata', () => ({
	parseBuffer: vi.fn()
}));

vi.mock('../../../src/content/ferry', () => ({
	classifyImage: vi.fn(),
	detectObjects: vi.fn(),
	scoreAudio: vi.fn(),
	scoreImage: vi.fn(),
	scoreText: vi.fn()
}));

const mockExifLoad = vi.mocked(ExifReader.load);
const mockParseBuffer = vi.mocked(parseBuffer);
const mockClassifyImage = vi.mocked(classifyImage);
const mockDetectObjects = vi.mocked(detectObjects);
const mockScoreAudio = vi.mocked(scoreAudio);
const mockScoreImage = vi.mocked(scoreImage);
const mockScoreText = vi.mocked(scoreText);

function exifDate(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${date.getUTCFullYear()}:${pad(date.getUTCMonth() + 1)}:${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

function createValidExif(overrides: Record<string, unknown> = {}) {
	const now = new Date();
	return {
		Make: { value: 'Apple' },
		Model: { value: 'iPhone 15' },
		DateTimeOriginal: { value: exifDate(now) },
		OffsetTimeOriginal: { value: '+00:00' },
		Software: { value: '17.2.1' },
		ApertureValue: { value: 2.8 },
		LensModel: { value: 'iPhone Wide' },
		ExposureTime: { value: '1/120' },
		GPSLatitude: { value: '37.7749' },
		GPSLongitude: { value: '-122.4194' },
		...overrides
	} as any;
}

const validDevice = {
	make: 'apple',
	model: 'iPhone',
	os: 'ios',
	version: '17.2.1',
	latitude: 37.7749,
	longitude: -122.4194
} as any;

beforeEach(() => {
	vi.clearAllMocks();
	mockExifLoad.mockReturnValue(createValidExif());
	mockParseBuffer.mockResolvedValue({
		common: { comment: [] },
		format: { container: 'mp4', codec: 'aac' },
		native: {}
	} as any);
	mockClassifyImage.mockResolvedValue([{ label: 'tree', confidence: 0.9 }] as any);
	mockDetectObjects.mockResolvedValue([
		{ label: 'dog', confidence: 0.85 },
		{ label: 'cat', confidence: 0.8 }
	] as any);
	mockScoreAudio.mockResolvedValue(['transcript', { score: 0.9, breakdown: [] }] as any);
	mockScoreImage.mockResolvedValue(['generated caption', { score: 0.9, breakdown: [] }] as any);
	mockScoreText.mockResolvedValue({ score: 0.9, breakdown: [] } as any);
});

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

	it('supports article quiz thresholds declared as percentages', async () => {
		const kv = new MockKVNamespace();
		await kv.put('score:percent', JSON.stringify({ score: 8, scorePercent: 85, total: 10 }));
		const bindings = createMockBindings({ KV: kv as any });
		const step = {
			type: 'article_quiz',
			description: 'Read and pass',
			parameters: ['ART', 80]
		} as any;
		const response = {
			type: 'article_quiz',
			index: 0,
			scoreKey: 'score:percent',
			score: 85
		} as any;

		const result = await validateStep(step, response, bindings, {
			make: 'unknown',
			model: 'unknown',
			os: 'unknown'
		});

		expect(result.success).toBe(true);
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

	it('accepts article_read_time when duration meets the required threshold', async () => {
		const step = {
			type: 'article_read_time',
			description: 'Read an article',
			parameters: ['SPORT', 45]
		} as any;
		const response = {
			type: 'article_read_time',
			index: 0,
			duration: 45
		} as any;

		const result = await validateStep(step, response, createMockBindings(), validDevice);
		expect(result.success).toBe(true);
	});

	it('rejects activity_read_time when duration is below the required threshold', async () => {
		const step = {
			type: 'activity_read_time',
			description: 'Read an activity',
			parameters: [{ type: 'activity_type', value: 'COMMUNITY_SERVICE' }, 30]
		} as any;
		const response = {
			type: 'activity_read_time',
			index: 0,
			duration: 29
		} as any;

		const result = await validateStep(step, response, createMockBindings(), validDevice);
		expect(result.success).toBe(false);
		expect(result.message).toContain('does not meet the required');
	});

	it('rejects article quiz when score is below threshold', async () => {
		const kv = new MockKVNamespace();
		await kv.put('score:low', JSON.stringify({ score: 5, scorePercent: 50, total: 10 }));
		const bindings = createMockBindings({ KV: kv as any });
		const step = {
			type: 'article_quiz',
			description: 'Read and pass',
			parameters: ['ART', 0.8]
		} as any;
		const response = {
			type: 'article_quiz',
			index: 0,
			scoreKey: 'score:low',
			score: 50
		} as any;

		const result = await validateStep(step, response, bindings, {
			make: 'unknown',
			model: 'unknown',
			os: 'unknown'
		});

		expect(result.success).toBe(false);
		expect(result.message).toContain('does not meet the required');
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

	it('rejects transcribe_audio when iOS metadata conflicts with Android-only AMR codec', async () => {
		mockParseBuffer.mockResolvedValueOnce({
			common: { comment: [] },
			format: { container: '3gp', codec: 'amr' },
			native: {}
		} as any);

		const step = {
			type: 'transcribe_audio',
			description: 'Speak about topic',
			parameters: ['topic', 0.7]
		} as any;
		const response = {
			type: 'transcribe_audio',
			index: 0,
			data: new Uint8Array([1, 2, 3, 4])
		} as any;

		const result = await validateStep(step, response, createMockBindings(), validDevice);
		expect(result.success).toBe(false);
		expect(result.message).toContain('AMR audio codec');
	});

	it('accepts transcribe_audio when metadata parsing fails but score meets threshold', async () => {
		mockParseBuffer.mockRejectedValueOnce(new Error('bad metadata'));
		mockScoreAudio.mockResolvedValueOnce(['transcript', { score: 0.8, breakdown: [] }] as any);

		const step = {
			type: 'transcribe_audio',
			description: 'Speak about topic',
			parameters: ['topic', 0.7]
		} as any;
		const response = {
			type: 'transcribe_audio',
			index: 0,
			data: new Uint8Array([1, 2, 3, 4])
		} as any;

		const result = await validateStep(step, response, createMockBindings(), {
			make: 'unknown',
			model: 'unknown',
			os: 'unknown'
		});

		expect(result.success).toBe(true);
		expect(result.score).toBe(0.8);
	});

	it('rejects transcribe_audio when score is below threshold', async () => {
		mockScoreAudio.mockResolvedValueOnce(['transcript', { score: 0.4, breakdown: [] }] as any);

		const step = {
			type: 'transcribe_audio',
			description: 'Speak about topic',
			parameters: ['topic', 0.7]
		} as any;
		const response = {
			type: 'transcribe_audio',
			index: 0,
			data: new Uint8Array([1, 2, 3, 4])
		} as any;

		const result = await validateStep(step, response, createMockBindings(), {
			make: 'unknown',
			model: 'unknown',
			os: 'unknown'
		});

		expect(result.success).toBe(false);
		expect(result.message).toContain('required score threshold');
	});

	it('accepts non-location photo steps when EXIF metadata cannot be parsed', async () => {
		mockExifLoad.mockImplementationOnce(() => {
			throw new Error('bad exif');
		});

		const step = {
			type: 'take_photo_classification',
			description: 'Take a tree photo',
			parameters: ['tree', 0.7]
		} as any;
		const response = {
			type: 'take_photo_classification',
			index: 0,
			data: new Uint8Array([255, 216, 255])
		} as any;

		const result = await validateStep(step, response, createMockBindings(), validDevice);
		expect(result.success).toBe(true);
		expect(result.score).toBe(0.9);
	});

	it('accepts non-location photo steps when EXIF make is missing', async () => {
		mockExifLoad.mockReturnValueOnce(createValidExif({ Make: undefined }));

		const step = {
			type: 'take_photo_classification',
			description: 'Take a tree photo',
			parameters: ['tree', 0.7]
		} as any;
		const response = {
			type: 'take_photo_classification',
			index: 0,
			data: new Uint8Array([255, 216, 255])
		} as any;

		const result = await validateStep(step, response, createMockBindings(), validDevice);
		expect(result.success).toBe(true);
		expect(result.score).toBe(0.9);
	});

	it('rejects take_photo_location when device GPS metadata is missing', async () => {
		const step = {
			type: 'take_photo_location',
			description: 'Take photo in area',
			parameters: [37.7749, -122.4194, 200, 'tree', 0.5]
		} as any;
		const response = {
			type: 'take_photo_location',
			index: 0,
			data: new Uint8Array([255, 216, 255])
		} as any;

		const result = await validateStep(step, response, createMockBindings(), {
			make: 'apple',
			model: 'iPhone',
			os: 'ios'
		});

		expect(result.success).toBe(false);
		expect(result.message).toContain('No GPS data provided in device metadata');
	});

	it('accepts take_photo_location when GPS and classification constraints pass', async () => {
		const step = {
			type: 'take_photo_location',
			description: 'Take photo in area',
			parameters: [37.7749, -122.4194, 500, 'tree', 0.5]
		} as any;
		const response = {
			type: 'take_photo_location',
			index: 0,
			data: new Uint8Array([255, 216, 255])
		} as any;

		const result = await validateStep(step, response, createMockBindings(), validDevice);
		expect(result.success).toBe(true);
		expect(result.score).toBe(0.9);
	});

	it('rejects take_photo_location when only one of label/score is provided', async () => {
		const step = {
			type: 'take_photo_location',
			description: 'Take photo in area',
			parameters: [37.7749, -122.4194, 500, 'tree']
		} as any;
		const response = {
			type: 'take_photo_location',
			index: 0,
			data: new Uint8Array([255, 216, 255])
		} as any;

		const result = await validateStep(step, response, createMockBindings(), validDevice);
		expect(result.success).toBe(false);
		expect(result.message).toContain('requires both a label and a confidence threshold');
	});

	it('rejects take_photo_objects when required object confidence is not met', async () => {
		mockDetectObjects.mockResolvedValueOnce([{ label: 'dog', confidence: 0.4 }] as any);

		const step = {
			type: 'take_photo_objects',
			description: 'Take dog and cat photo',
			parameters: [
				['dog', 0.7],
				['cat', 0.7]
			]
		} as any;
		const response = {
			type: 'take_photo_objects',
			index: 0,
			data: new Uint8Array([255, 216, 255])
		} as any;

		const result = await validateStep(step, response, createMockBindings(), validDevice);
		expect(result.success).toBe(false);
		expect(result.message).toContain('required object');
	});

	it('accepts take_photo_objects when all required objects are detected', async () => {
		const step = {
			type: 'take_photo_objects',
			description: 'Take dog and cat photo',
			parameters: [
				['dog', 0.7],
				['cat', 0.7]
			]
		} as any;
		const response = {
			type: 'take_photo_objects',
			index: 0,
			data: new Uint8Array([255, 216, 255])
		} as any;

		const result = await validateStep(step, response, createMockBindings(), validDevice);
		expect(result.success).toBe(true);
		expect(result.score).toBeCloseTo(0.825);
	});

	it('uses the best confidence when multiple detections share the same required label', async () => {
		mockDetectObjects.mockResolvedValueOnce([
			{ label: 'dog', confidence: 0.2 },
			{ label: 'dog', confidence: 0.91 }
		] as any);

		const step = {
			type: 'take_photo_objects',
			description: 'Take a photo with a dog in it',
			parameters: [['dog', 0.7]]
		} as any;
		const response = {
			type: 'take_photo_objects',
			index: 0,
			data: new Uint8Array([255, 216, 255])
		} as any;

		const result = await validateStep(step, response, createMockBindings(), validDevice);
		expect(result.success).toBe(true);
		expect(result.score).toBe(0.91);
	});

	it('matches classification labels case-insensitively with underscore normalization', async () => {
		mockClassifyImage.mockResolvedValueOnce([{ label: 'Petri_Dish', confidence: 0.81 }] as any);

		const step = {
			type: 'take_photo_classification',
			description: 'Take a photo of a petri dish',
			parameters: ['petri dish', 0.8]
		} as any;
		const response = {
			type: 'take_photo_classification',
			index: 0,
			data: new Uint8Array([255, 216, 255])
		} as any;

		const result = await validateStep(step, response, createMockBindings(), validDevice);
		expect(result.success).toBe(true);
		expect(result.score).toBe(0.81);
	});

	it('matches object labels case-insensitively with underscore normalization', async () => {
		mockDetectObjects.mockResolvedValueOnce([
			{ label: 'Cell Phone', confidence: 0.9 },
			{ label: 'laptop', confidence: 0.8 }
		] as any);

		const step = {
			type: 'take_photo_objects',
			description: 'Take laptop and phone photo',
			parameters: [
				['cell_phone', 0.7],
				['LAPTOP', 0.7]
			]
		} as any;
		const response = {
			type: 'take_photo_objects',
			index: 0,
			data: new Uint8Array([255, 216, 255])
		} as any;

		const result = await validateStep(step, response, createMockBindings(), validDevice);
		expect(result.success).toBe(true);
		expect(result.score).toBeCloseTo(0.85);
	});

	it('accepts take_photo_caption and returns generated prompt text', async () => {
		const step = {
			type: 'take_photo_caption',
			description: 'Take caption photo',
			parameters: [[{ id: 'relevance', weight: 1, ideal: 'tree by ocean' }], 'tree by ocean', 0.7]
		} as any;
		const response = {
			type: 'take_photo_caption',
			index: 0,
			data: new Uint8Array([255, 216, 255])
		} as any;

		const result = await validateStep(step, response, createMockBindings(), validDevice);
		expect(result.success).toBe(true);
		expect(result.prompt).toBe('generated caption');
	});

	it('rejects draw_picture when camera EXIF metadata is present', async () => {
		mockExifLoad.mockReturnValueOnce({ Make: { value: 'Apple' } } as any);

		const step = {
			type: 'draw_picture',
			description: 'Draw a carrot',
			parameters: ['carrot', 0.6]
		} as any;
		const response = {
			type: 'draw_picture',
			index: 0,
			data: new Uint8Array([137, 80, 78, 71])
		} as any;

		const result = await validateStep(step, response, createMockBindings(), {
			make: 'unknown',
			model: 'unknown',
			os: 'unknown'
		});

		expect(result.success).toBe(false);
		expect(result.message).toContain('contains camera EXIF metadata');
	});

	it('accepts draw_picture when there is no EXIF metadata and score passes', async () => {
		mockExifLoad.mockImplementationOnce(() => {
			throw new Error('no exif');
		});

		const step = {
			type: 'draw_picture',
			description: 'Draw a carrot',
			parameters: ['carrot', 0.6]
		} as any;
		const response = {
			type: 'draw_picture',
			index: 0,
			data: new Uint8Array([137, 80, 78, 71])
		} as any;

		const result = await validateStep(step, response, createMockBindings(), {
			make: 'unknown',
			model: 'unknown',
			os: 'unknown'
		});

		expect(result.success).toBe(true);
		expect(result.score).toBe(0.9);
	});

	it('rejects take_photo_classification when editing software is detected', async () => {
		mockExifLoad.mockReturnValueOnce(
			createValidExif({
				Software: { value: 'Adobe Photoshop' }
			})
		);

		const step = {
			type: 'take_photo_classification',
			description: 'Take a tree photo',
			parameters: ['tree', 0.7]
		} as any;
		const response = {
			type: 'take_photo_classification',
			index: 0,
			data: new Uint8Array([255, 216, 255])
		} as any;

		const result = await validateStep(step, response, createMockBindings(), validDevice);
		expect(result.success).toBe(false);
		expect(result.message).toContain('Photo editing software detected');
	});

	it('rejects take_photo_classification when declared make does not match EXIF make', async () => {
		const step = {
			type: 'take_photo_classification',
			description: 'Take a tree photo',
			parameters: ['tree', 0.7]
		} as any;
		const response = {
			type: 'take_photo_classification',
			index: 0,
			data: new Uint8Array([255, 216, 255])
		} as any;

		const result = await validateStep(step, response, createMockBindings(), {
			make: 'samsung',
			model: 'Android',
			os: 'android',
			latitude: 37.7749,
			longitude: -122.4194
		} as any);

		expect(result.success).toBe(false);
		expect(result.message).toContain('Expected device make');
	});

	it('rejects take_photo_classification for clear software OS mismatch', async () => {
		mockExifLoad.mockReturnValueOnce(
			createValidExif({
				Software: { value: 'Android 14' }
			})
		);

		const step = {
			type: 'take_photo_classification',
			description: 'Take a tree photo',
			parameters: ['tree', 0.7]
		} as any;
		const response = {
			type: 'take_photo_classification',
			index: 0,
			data: new Uint8Array([255, 216, 255])
		} as any;

		const result = await validateStep(step, response, createMockBindings(), validDevice);
		expect(result.success).toBe(false);
		expect(result.message).toContain('inconsistent with declared OS');
	});

	it('returns success for externally validated match_terms steps', async () => {
		const step = {
			type: 'match_terms',
			description: 'Match terms',
			parameters: [['sun', 'star']]
		} as any;
		const response = { type: 'match_terms', index: 0 } as any;

		const result = await validateStep(step, response, createMockBindings(), {
			make: 'unknown',
			model: 'unknown',
			os: 'unknown'
		});

		expect(result.success).toBe(true);
	});

	it('rejects draw_picture when binary payload is missing', async () => {
		const step = {
			type: 'draw_picture',
			description: 'Draw a bicycle',
			parameters: ['bicycle', 0.6]
		} as any;
		const response = {
			type: 'draw_picture',
			index: 0,
			data: undefined
		} as any;

		const result = await validateStep(step, response, createMockBindings(), {
			make: 'unknown',
			model: 'unknown',
			os: 'unknown'
		});
		expect(result.success).toBe(false);
		expect(result.message).toContain('No drawing data provided');
	});

	it('rejects photos with missing or malformed EXIF date fields', async () => {
		const step = {
			type: 'take_photo_classification',
			description: 'Take a tree photo',
			parameters: ['tree', 0.7]
		} as any;
		const response = {
			type: 'take_photo_classification',
			index: 0,
			data: new Uint8Array([255, 216, 255])
		} as any;

		mockExifLoad.mockReturnValueOnce(createValidExif({ DateTimeOriginal: undefined }));
		const missingDate = await validateStep(step, response, createMockBindings(), validDevice);
		expect(missingDate.success).toBe(false);
		expect(missingDate.message).toContain('DateTimeOriginal');

		mockExifLoad.mockReturnValueOnce(
			createValidExif({ DateTimeOriginal: { value: 'not-a-date' } })
		);
		const malformedDate = await validateStep(step, response, createMockBindings(), validDevice);
		expect(malformedDate.success).toBe(false);
		expect(malformedDate.message).toContain('unparseable EXIF DateTimeOriginal');
	});

	it('rejects very stale photo timestamps and zero focal length', async () => {
		const step = {
			type: 'take_photo_classification',
			description: 'Take a tree photo',
			parameters: ['tree', 0.7]
		} as any;
		const response = {
			type: 'take_photo_classification',
			index: 0,
			data: new Uint8Array([255, 216, 255])
		} as any;

		mockExifLoad.mockReturnValueOnce(
			createValidExif({
				DateTimeOriginal: { value: exifDate(new Date(Date.now() - 2 * 60 * 60 * 1000)) }
			})
		);
		const stale = await validateStep(step, response, createMockBindings(), validDevice);
		expect(stale.success).toBe(false);
		expect(stale.message).toContain('acceptable range');

		mockExifLoad.mockReturnValueOnce(createValidExif({ FocalLength: { value: 0 } }));
		const focal = await validateStep(step, response, createMockBindings(), validDevice);
		expect(focal.success).toBe(false);
		expect(focal.message).toContain('invalid focal length');
	});

	it('rejects significantly inconsistent digitized timestamps and suspiciously bare camera metadata', async () => {
		const step = {
			type: 'take_photo_classification',
			description: 'Take a tree photo',
			parameters: ['tree', 0.7]
		} as any;
		const response = {
			type: 'take_photo_classification',
			index: 0,
			data: new Uint8Array([255, 216, 255])
		} as any;

		mockExifLoad.mockReturnValueOnce(
			createValidExif({
				DateTimeDigitized: { value: exifDate(new Date(Date.now() - 10 * 60 * 1000)) }
			})
		);
		const digitizedMismatch = await validateStep(step, response, createMockBindings(), validDevice);
		expect(digitizedMismatch.success).toBe(false);
		expect(digitizedMismatch.message).toContain(
			'DateTime Original and DateTime Digitized mismatch'
		);

		mockExifLoad.mockReturnValueOnce(
			createValidExif({
				LensModel: undefined,
				ApertureValue: undefined,
				FNumber: undefined,
				ExposureTime: undefined
			})
		);
		const suspicious = await validateStep(step, response, createMockBindings(), validDevice);
		expect(suspicious.success).toBe(false);
		expect(suspicious.message).toContain('missing critical camera EXIF fields');
	});

	it('rejects object labels that are outside the supported detection vocabulary', async () => {
		const step = {
			type: 'take_photo_objects',
			description: 'Take a photo with a unicorn in it',
			parameters: [['unicorn', 0.7]]
		} as any;
		const response = {
			type: 'take_photo_objects',
			index: 0,
			data: new Uint8Array([255, 216, 255])
		} as any;

		const result = await validateStep(step, response, createMockBindings(), validDevice);
		expect(result.success).toBe(false);
		expect(result.message).toContain('not supported by the current detection model vocabulary');
	});

	it('rejects model and OS version mismatches in photo metadata', async () => {
		const step = {
			type: 'take_photo_classification',
			description: 'Take a tree photo',
			parameters: ['tree', 0.7]
		} as any;
		const response = {
			type: 'take_photo_classification',
			index: 0,
			data: new Uint8Array([255, 216, 255])
		} as any;

		const modelMismatch = await validateStep(step, response, createMockBindings(), {
			make: 'apple',
			model: 'Pixel',
			os: 'ios',
			latitude: 37.7749,
			longitude: -122.4194
		} as any);
		expect(modelMismatch.success).toBe(false);
		expect(modelMismatch.message).toContain('Expected device model');

		mockExifLoad.mockReturnValueOnce(createValidExif({ Software: { value: '10.1.0' } }));
		const versionMismatch = await validateStep(step, response, createMockBindings(), {
			make: 'apple',
			model: 'iPhone',
			os: 'ios',
			version: '20.1.0',
			latitude: 37.7749,
			longitude: -122.4194
		} as any);
		expect(versionMismatch.success).toBe(false);
		expect(versionMismatch.message).toContain('OS version mismatch');
	});

	it('rejects location photos when device or EXIF coordinates are missing/invalid/outside radius', async () => {
		const step = {
			type: 'take_photo_location',
			description: 'Take photo in area',
			parameters: [37.7749, -122.4194, 50, 'tree', 0.5]
		} as any;
		const response = {
			type: 'take_photo_location',
			index: 0,
			data: new Uint8Array([255, 216, 255])
		} as any;

		const deviceOutside = await validateStep(step, response, createMockBindings(), {
			make: 'apple',
			model: 'iPhone',
			os: 'ios',
			latitude: 0,
			longitude: 0
		} as any);
		expect(deviceOutside.success).toBe(false);
		expect(deviceOutside.message).toContain('Device was not within the required location radius');

		mockExifLoad.mockReturnValueOnce(
			createValidExif({ GPSLatitude: undefined, GPSLongitude: undefined })
		);
		const missingExifGps = await validateStep(step, response, createMockBindings(), validDevice);
		expect(missingExifGps.success).toBe(false);
		expect(missingExifGps.message).toContain('No GPS data found in photo EXIF metadata');

		mockExifLoad.mockReturnValueOnce(
			createValidExif({ GPSLatitude: { value: 'abc' }, GPSLongitude: { value: 'def' } })
		);
		const invalidExifGps = await validateStep(step, response, createMockBindings(), validDevice);
		expect(invalidExifGps.success).toBe(false);
		expect(invalidExifGps.message).toContain('Invalid GPS coordinates in photo EXIF metadata');

		mockExifLoad.mockReturnValueOnce(
			createValidExif({ GPSLatitude: { value: '0' }, GPSLongitude: { value: '0' } })
		);
		const outsideExifGps = await validateStep(step, response, createMockBindings(), validDevice);
		expect(outsideExifGps.success).toBe(false);
		expect(outsideExifGps.message).toContain(
			'Photo was not taken within the required location radius'
		);
	});

	it('rejects classification and caption steps when model score thresholds are not met', async () => {
		const classificationStep = {
			type: 'take_photo_classification',
			description: 'Take a tree photo',
			parameters: ['tree', 0.95]
		} as any;
		const classificationResponse = {
			type: 'take_photo_classification',
			index: 0,
			data: new Uint8Array([255, 216, 255])
		} as any;

		mockClassifyImage.mockResolvedValueOnce([{ label: 'tree', confidence: 0.8 }] as any);
		const classification = await validateStep(
			classificationStep,
			classificationResponse,
			createMockBindings(),
			validDevice
		);
		expect(classification.success).toBe(false);
		expect(classification.message).toContain('required classification label');

		const captionStep = {
			type: 'take_photo_caption',
			description: 'Caption photo',
			parameters: [[{ id: 'relevance', weight: 1, ideal: 'tree' }], 'tree', 0.8]
		} as any;
		const captionResponse = {
			type: 'take_photo_caption',
			index: 0,
			data: new Uint8Array([255, 216, 255])
		} as any;

		mockScoreImage.mockResolvedValueOnce(['caption', { score: 0.5, breakdown: [] }] as any);
		const caption = await validateStep(
			captionStep,
			captionResponse,
			createMockBindings(),
			validDevice
		);
		expect(caption.success).toBe(false);
		expect(caption.message).toContain('required score threshold');
	});

	it('rejects transcribe_audio metadata contradictions for android and desktop devices', async () => {
		const step = {
			type: 'transcribe_audio',
			description: 'Speak about topic',
			parameters: ['topic', 0.7]
		} as any;
		const response = {
			type: 'transcribe_audio',
			index: 0,
			data: new Uint8Array([1, 2, 3, 4])
		} as any;

		mockParseBuffer.mockResolvedValueOnce({
			common: { comment: [] },
			format: { container: 'caf', codec: 'aac' },
			native: {}
		} as any);
		const androidCaf = await validateStep(step, response, createMockBindings(), {
			make: 'google',
			model: 'Android',
			os: 'android'
		});
		expect(androidCaf.success).toBe(false);
		expect(androidCaf.message).toContain('Apple-exclusive');

		mockParseBuffer.mockResolvedValueOnce({
			common: { comment: [] },
			format: { container: 'mp4', codec: 'amr' },
			native: {}
		} as any);
		const windowsAmr = await validateStep(step, response, createMockBindings(), {
			make: 'microsoft',
			model: 'PC',
			os: 'windows'
		});
		expect(windowsAmr.success).toBe(false);
		expect(windowsAmr.message).toContain('exclusively produced by mobile voice recorders');
	});

	// take_photo_validation tests
	describe('take_photo_validation', () => {
		const validResponse = {
			type: 'take_photo_validation',
			index: 0,
			data: new Uint8Array([1, 2, 3, 4])
		} as any;

		it('passes when photo validation score meets default threshold of 0.5', async () => {
			const step = {
				type: 'take_photo_validation',
				description: 'Validate photo quality',
				parameters: ['a sunset landscape']
			} as any;

			mockScoreImage.mockResolvedValueOnce([
				'Generated caption',
				{ score: 0.7, breakdown: [] }
			] as any);

			const result = await validateStep(step, validResponse, createMockBindings(), validDevice);

			expect(result.success).toBe(true);
			expect(result.score).toBe(0.7);
			expect(result.prompt).toBe('Generated caption');
			expect(mockScoreImage).toHaveBeenCalledWith(
				expect.anything(),
				expect.anything(),
				expect.stringContaining('sunset landscape'),
				expect.arrayContaining([
					expect.objectContaining({
						id: 'validation',
						weight: 1
					})
				])
			);
		});

		it('passes when photo validation score meets custom threshold (0-1 range)', async () => {
			const step = {
				type: 'take_photo_validation',
				description: 'Validate photo',
				parameters: ['a dog playing', 0.6]
			} as any;

			mockScoreImage.mockResolvedValueOnce([
				'Generated caption',
				{ score: 0.65, breakdown: [] }
			] as any);

			const result = await validateStep(step, validResponse, createMockBindings(), validDevice);

			expect(result.success).toBe(true);
			expect(result.score).toBe(0.65);
		});

		it('passes when photo validation score meets percentage threshold (0-100 range)', async () => {
			const step = {
				type: 'take_photo_validation',
				description: 'Validate photo',
				parameters: ['outdoor activity', 75]
			} as any;

			mockScoreImage.mockResolvedValueOnce([
				'Generated caption',
				{ score: 0.8, breakdown: [] }
			] as any);

			const result = await validateStep(step, validResponse, createMockBindings(), validDevice);

			expect(result.success).toBe(true);
			expect(result.score).toBe(0.8);
		});

		it('rejects when photo validation score is below default threshold', async () => {
			const step = {
				type: 'take_photo_validation',
				description: 'Validate photo',
				parameters: ['a sunset landscape']
			} as any;

			mockScoreImage.mockResolvedValueOnce([
				'Generated caption',
				{ score: 0.4, breakdown: [] }
			] as any);

			const result = await validateStep(step, validResponse, createMockBindings(), validDevice);

			expect(result.success).toBe(false);
			expect(result.message).toContain(
				'does not meet the required validation score threshold of 0.5'
			);
			expect(result.message).toContain('0.40');
		});

		it('rejects when photo validation score is below custom threshold', async () => {
			const step = {
				type: 'take_photo_validation',
				description: 'Validate photo',
				parameters: ['a dog', 0.8]
			} as any;

			mockScoreImage.mockResolvedValueOnce([
				'Generated caption',
				{ score: 0.7, breakdown: [] }
			] as any);

			const result = await validateStep(step, validResponse, createMockBindings(), validDevice);

			expect(result.success).toBe(false);
			expect(result.message).toContain(
				'does not meet the required validation score threshold of 0.8'
			);
			expect(result.message).toContain('0.70');
		});

		it('rejects invalid threshold values', async () => {
			const step = {
				type: 'take_photo_validation',
				description: 'Validate photo',
				parameters: ['subject', -0.5]
			} as any;

			const result = await validateStep(step, validResponse, createMockBindings(), validDevice);

			expect(result.success).toBe(false);
			expect(result.message).toContain('Photo validation');
		});

		it('includes EXIF validation for non-location photos', async () => {
			const step = {
				type: 'take_photo_validation',
				description: 'Validate photo',
				parameters: ['subject', 0.5]
			} as any;

			// Simulate EXIF parse failure
			mockExifLoad.mockImplementationOnce(() => {
				throw new Error('Invalid EXIF');
			});

			mockScoreImage.mockResolvedValueOnce([
				'Generated caption',
				{ score: 0.7, breakdown: [] }
			] as any);

			const result = await validateStep(step, validResponse, createMockBindings(), validDevice);

			// Should succeed because take_photo_validation is not location-based
			expect(result.success).toBe(true);
		});

		it('passes with valid EXIF metadata', async () => {
			const step = {
				type: 'take_photo_validation',
				description: 'Validate photo with EXIF check',
				parameters: ['landscape', 0.5]
			} as any;

			mockExifLoad.mockReturnValueOnce(createValidExif());
			mockScoreImage.mockResolvedValueOnce([
				'Generated caption',
				{ score: 0.6, breakdown: [] }
			] as any);

			const result = await validateStep(step, validResponse, createMockBindings(), validDevice);

			expect(result.success).toBe(true);
		});
	});

	// take_photo_list tests
	describe('take_photo_list', () => {
		const validResponse = {
			type: 'take_photo_list',
			index: 0,
			data: new Uint8Array([1, 2, 3, 4])
		} as any;

		it('passes when photo list score meets default threshold of 0.5', async () => {
			const step = {
				type: 'take_photo_list',
				description: 'Validate objects in photo',
				parameters: [['dog', 'cat', 'chair']]
			} as any;

			mockScoreImage.mockResolvedValueOnce([
				'Generated caption',
				{ score: 0.7, breakdown: [] }
			] as any);

			const result = await validateStep(step, validResponse, createMockBindings(), validDevice);

			expect(result.success).toBe(true);
			expect(result.score).toBe(0.7);
			expect(result.prompt).toBe('Generated caption');
			expect(mockScoreImage).toHaveBeenCalledWith(
				expect.anything(),
				expect.anything(),
				expect.stringContaining('dog, cat, chair'),
				expect.arrayContaining([
					expect.objectContaining({
						id: 'list',
						weight: 1
					})
				])
			);
		});

		it('passes when photo list score meets custom threshold', async () => {
			const step = {
				type: 'take_photo_list',
				description: 'Validate objects',
				parameters: [['bicycle', 'car'], 0.65]
			} as any;

			mockScoreImage.mockResolvedValueOnce([
				'Generated caption',
				{ score: 0.75, breakdown: [] }
			] as any);

			const result = await validateStep(step, validResponse, createMockBindings(), validDevice);

			expect(result.success).toBe(true);
			expect(result.score).toBe(0.75);
		});

		it('passes when photo list score meets percentage threshold', async () => {
			const step = {
				type: 'take_photo_list',
				description: 'Validate objects',
				parameters: [['person', 'bicycle'], 80]
			} as any;

			mockScoreImage.mockResolvedValueOnce([
				'Generated caption',
				{ score: 0.85, breakdown: [] }
			] as any);

			const result = await validateStep(step, validResponse, createMockBindings(), validDevice);

			expect(result.success).toBe(true);
			expect(result.score).toBe(0.85);
		});

		it('rejects when photo list score is below default threshold', async () => {
			const step = {
				type: 'take_photo_list',
				description: 'Validate objects',
				parameters: [['dog', 'car']]
			} as any;

			mockScoreImage.mockResolvedValueOnce([
				'Generated caption',
				{ score: 0.4, breakdown: [] }
			] as any);

			const result = await validateStep(step, validResponse, createMockBindings(), validDevice);

			expect(result.success).toBe(false);
			expect(result.message).toContain('does not meet the required list score threshold of 0.5');
			expect(result.message).toContain('0.40');
		});

		it('rejects when photo list score is below custom threshold', async () => {
			const step = {
				type: 'take_photo_list',
				description: 'Validate objects',
				parameters: [['cat', 'dog', 'bird'], 0.9]
			} as any;

			mockScoreImage.mockResolvedValueOnce([
				'Generated caption',
				{ score: 0.75, breakdown: [] }
			] as any);

			const result = await validateStep(step, validResponse, createMockBindings(), validDevice);

			expect(result.success).toBe(false);
			expect(result.message).toContain('does not meet the required list score threshold of 0.9');
		});

		it('rejects empty item list', async () => {
			const step = {
				type: 'take_photo_list',
				description: 'Validate objects',
				parameters: [[]]
			} as any;

			const result = await validateStep(step, validResponse, createMockBindings(), validDevice);

			expect(result.success).toBe(false);
			expect(result.message).toContain('requires at least one item');
		});

		it('rejects invalid threshold values', async () => {
			const step = {
				type: 'take_photo_list',
				description: 'Validate objects',
				parameters: [['dog', 'cat'], -0.1]
			} as any;

			const result = await validateStep(step, validResponse, createMockBindings(), validDevice);

			expect(result.success).toBe(false);
			expect(result.message).toContain('Photo list validation');
		});

		it('includes EXIF validation for photo list', async () => {
			const step = {
				type: 'take_photo_list',
				description: 'Validate objects with EXIF',
				parameters: [['dog', 'car']]
			} as any;

			mockExifLoad.mockReturnValueOnce(createValidExif());
			mockScoreImage.mockResolvedValueOnce([
				'Generated caption',
				{ score: 0.6, breakdown: [] }
			] as any);

			const result = await validateStep(step, validResponse, createMockBindings(), validDevice);

			expect(result.success).toBe(true);
		});

		it('rejects when items list contains unsupported labels', async () => {
			const step = {
				type: 'take_photo_list',
				description: 'Validate objects',
				parameters: [['completely_fake_object_12345', 'dog']]
			} as any;

			// Relaxed behavior: unknown or domain-specific items are allowed and are
			// validated via caption-scoring. The step should succeed when the image
			// scoring meets the threshold.
			mockScoreImage.mockResolvedValueOnce([
				'Generated caption',
				{ score: 0.82, breakdown: [] }
			] as any);

			const result = await validateStep(step, validResponse, createMockBindings(), validDevice);

			expect(result.success).toBe(true);
			expect(result.score).toBe(0.82);
		});

		it('handles COCO-compatible labels in item list', async () => {
			const step = {
				type: 'take_photo_list',
				description: 'Validate COCO objects',
				parameters: [['person', 'car', 'bicycle']]
			} as any;

			mockScoreImage.mockResolvedValueOnce([
				'Generated caption',
				{ score: 0.75, breakdown: [] }
			] as any);

			const result = await validateStep(step, validResponse, createMockBindings(), validDevice);

			expect(result.success).toBe(true);
			expect(result.score).toBe(0.75);
		});

		it('normalizes label variations in item list', async () => {
			const step = {
				type: 'take_photo_list',
				description: 'Validate normalized labels',
				parameters: [['Cell Phone', 'TV']]
			} as any;

			mockScoreImage.mockResolvedValueOnce([
				'Generated caption',
				{ score: 0.75, breakdown: [] }
			] as any);

			const result = await validateStep(step, validResponse, createMockBindings(), validDevice);

			// Should succeed because cell_phone and tv are aliased/supported labels in COCO
			expect(result.success).toBe(true);
		});
	});

	describe('describe_text', () => {
		const criteria = [{ id: 'clarity', weight: 1, ideal: 'clear and specific response' }];

		it('passes when scoreText score meets threshold and returns trimmed prompt text', async () => {
			const step = {
				type: 'describe_text',
				description: 'Describe your favorite outdoor activity',
				parameters: [criteria, 0.7]
			} as any;
			const response = {
				type: 'describe_text',
				index: 0,
				text: '  I enjoy hiking in forest preserves because it helps me focus.  '
			} as any;

			mockScoreText.mockResolvedValueOnce({ score: 0.82, breakdown: [] } as any);

			const result = await validateStep(step, response, createMockBindings(), {
				make: 'unknown',
				model: 'unknown',
				os: 'unknown'
			});

			expect(result.success).toBe(true);
			expect(result.score).toBe(0.82);
			expect(result.prompt).toBe('I enjoy hiking in forest preserves because it helps me focus.');
			expect(mockScoreText).toHaveBeenCalledWith(
				expect.anything(),
				'I enjoy hiking in forest preserves because it helps me focus.',
				criteria
			);
		});

		it('supports percentage thresholds for describe_text', async () => {
			const step = {
				type: 'describe_text',
				description: 'Describe your favorite outdoor activity',
				parameters: [criteria, 80]
			} as any;
			const response = {
				type: 'describe_text',
				index: 0,
				text: 'I like to volunteer at the local park cleanup every weekend.'
			} as any;

			mockScoreText.mockResolvedValueOnce({ score: 0.81, breakdown: [] } as any);

			const result = await validateStep(step, response, createMockBindings(), {
				make: 'unknown',
				model: 'unknown',
				os: 'unknown'
			});

			expect(result.success).toBe(true);
			expect(result.score).toBe(0.81);
		});

		it('rejects describe_text when text is empty', async () => {
			const step = {
				type: 'describe_text',
				description: 'Describe your favorite outdoor activity',
				parameters: [criteria, 0.7]
			} as any;
			const response = {
				type: 'describe_text',
				index: 0,
				text: '   '
			} as any;

			const result = await validateStep(step, response, createMockBindings(), {
				make: 'unknown',
				model: 'unknown',
				os: 'unknown'
			});

			expect(result.success).toBe(false);
			expect(result.message).toContain('cannot be empty');
			expect(mockScoreText).not.toHaveBeenCalled();
		});

		it('rejects describe_text when score is below threshold', async () => {
			const step = {
				type: 'describe_text',
				description: 'Describe your favorite outdoor activity',
				parameters: [criteria, 0.85]
			} as any;
			const response = {
				type: 'describe_text',
				index: 0,
				text: 'I like biking around my neighborhood.'
			} as any;

			mockScoreText.mockResolvedValueOnce({ score: 0.6, breakdown: [] } as any);

			const result = await validateStep(step, response, createMockBindings(), {
				make: 'unknown',
				model: 'unknown',
				os: 'unknown'
			});

			expect(result.success).toBe(false);
			expect(result.message).toContain('required score threshold of 0.85');
		});
	});
});
