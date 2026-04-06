import { beforeEach, describe, expect, it, vi } from 'vitest';
import { validateStep } from '../../../src/user/quests/validation';
import { createMockBindings } from '../../helpers/mock-bindings';
import { MockKVNamespace } from '../../helpers/mock-kv';
import ExifReader from 'exifreader';
import { parseBuffer } from 'music-metadata';
import { classifyImage, detectObjects, scoreAudio, scoreImage } from '../../../src/content/ferry';

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
	scoreImage: vi.fn()
}));

const mockExifLoad = vi.mocked(ExifReader.load);
const mockParseBuffer = vi.mocked(parseBuffer);
const mockClassifyImage = vi.mocked(classifyImage);
const mockDetectObjects = vi.mocked(detectObjects);
const mockScoreAudio = vi.mocked(scoreAudio);
const mockScoreImage = vi.mocked(scoreImage);

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

	it('rejects take_photo_classification when EXIF metadata cannot be parsed', async () => {
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
		expect(result.success).toBe(false);
		expect(result.message).toContain('Failed to parse photo EXIF metadata');
	});

	it('rejects take_photo_classification when EXIF make is missing', async () => {
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
		expect(result.success).toBe(false);
		expect(result.message).toContain('missing the required EXIF Make field');
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

	it('rejects stale photo timestamps and zero focal length', async () => {
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
				DateTimeOriginal: { value: exifDate(new Date(Date.now() - 10 * 60 * 1000)) }
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

	it('rejects inconsistent digitized timestamps and suspiciously bare camera metadata', async () => {
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
			createValidExif({ DateTimeDigitized: { value: exifDate(new Date(Date.now() - 120000)) } })
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
});
