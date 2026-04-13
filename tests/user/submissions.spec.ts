import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	addSubmissionToIndex,
	deleteEventImageSubmissions,
	getEventImage,
	getEventImageSubmissionsWithData,
	removeSubmissionFromIndex,
	submitEventImage
} from '../../src/user/submissions';
import { createMockBindings } from '../helpers/mock-bindings';
import { MockKVNamespace } from '../helpers/mock-kv';
import ExifReader from 'exifreader';
import { extractCountry, reverseGeocode } from '../../src/util/maps';
import { addBadgeProgress } from '../../src/user/badges';

vi.mock('exifreader', () => ({
	default: {
		load: vi.fn(() => {
			throw new Error('no exif');
		})
	}
}));

vi.mock('../../src/util/maps', () => ({
	extractCountry: vi.fn(() => null),
	reverseGeocode: vi.fn(async () => null)
}));

vi.mock('../../src/user/badges', () => ({
	addBadgeProgress: vi.fn(async () => undefined)
}));

const mockExifLoad = vi.mocked(ExifReader.load);
const mockExtractCountry = vi.mocked(extractCountry);
const mockReverseGeocode = vi.mocked(reverseGeocode);
const mockAddBadgeProgress = vi.mocked(addBadgeProgress);

beforeEach(() => {
	vi.clearAllMocks();
	mockExifLoad.mockImplementation(() => {
		throw new Error('no exif');
	});
	mockExtractCountry.mockReturnValue(null);
	mockReverseGeocode.mockResolvedValue(null as any);
	mockAddBadgeProgress.mockResolvedValue(undefined as any);
});

afterAll(() => {
	vi.unmock('../../src/util/maps');
	vi.unmock('../../src/user/badges');
	vi.unmock('exifreader');
	vi.resetModules();
});

describe('addSubmissionToIndex', () => {
	it('adds ids once and avoids duplicates', async () => {
		const kv = new MockKVNamespace();
		await addSubmissionToIndex('event:1:submission_ids', 'abc', Date.now(), kv as any);
		await addSubmissionToIndex('event:1:submission_ids', 'abc', Date.now(), kv as any);
		await addSubmissionToIndex('event:1:submission_ids', 'def', Date.now(), kv as any);

		const ids = await kv.get<string[]>('event:1:submission_ids', 'json');
		expect(ids).toEqual(['abc', 'def']);
	});
});

describe('removeSubmissionFromIndex', () => {
	it('returns without changes when index does not exist', async () => {
		const kv = new MockKVNamespace();
		await expect(
			removeSubmissionFromIndex('event:missing:submission_ids', 'ghost', kv as any)
		).resolves.toBeUndefined();
	});

	it('keeps index unchanged when id is not present', async () => {
		const kv = new MockKVNamespace();
		await kv.put('event:7:submission_ids', JSON.stringify(['a', 'b']));

		await removeSubmissionFromIndex('event:7:submission_ids', 'c', kv as any);

		const ids = await kv.get<string[]>('event:7:submission_ids', 'json');
		expect(ids).toEqual(['a', 'b']);
	});

	it('deletes index key when the final id is removed', async () => {
		const kv = new MockKVNamespace();
		await kv.put('event:2:submission_ids', JSON.stringify(['only']));
		await removeSubmissionFromIndex('event:2:submission_ids', 'only', kv as any);
		expect(await kv.get('event:2:submission_ids')).toBeNull();
	});
});

describe('submitEventImage', () => {
	it('rejects empty image payloads', async () => {
		const bindings = createMockBindings();
		await expect(
			submitEventImage(10n, 20n, new Uint8Array(), bindings, { waitUntil: () => {} } as any)
		).rejects.toThrow('Image data cannot be empty');
	});

	it('rejects missing event or user ids', async () => {
		const bindings = createMockBindings();
		await expect(
			submitEventImage(0n, 20n, new Uint8Array([1]), bindings, { waitUntil: () => {} } as any)
		).rejects.toThrow('Event ID and User ID are required for submitting an image');
	});

	it('stores encrypted image submission and index entries', async () => {
		const kv = new MockKVNamespace();
		const cache = new MockKVNamespace();
		const bindings = createMockBindings({ KV: kv as any, CACHE: cache as any });
		const pending: Promise<unknown>[] = [];
		const ctx = {
			waitUntil: (promise: Promise<unknown>) => {
				pending.push(Promise.resolve(promise));
			}
		};

		const image = new Uint8Array([1, 2, 3, 4, 5, 6]);
		const result = await submitEventImage(10n, 20n, image, bindings, ctx as any);
		await Promise.all(pending);

		expect(result.id).toHaveLength(32);
		expect(result.image).toEqual(image);

		const mapping = await kv.getWithMetadata<string, { eventId: string; userId: string }>(
			`event:submission:${result.id}`
		);
		expect(mapping.value).toContain(`events/10/submissions/20_${result.id}.webp`);
		expect(mapping.metadata?.eventId).toBe('10');
		expect(mapping.metadata?.userId).toBe('20');

		const eventIds = await kv.get<string[]>('event:10:submission_ids', 'json');
		const userIds = await kv.get<string[]>('user:20:submission_ids', 'json');
		const pairIds = await kv.get<string[]>('event:10:user:20:submission_ids', 'json');

		expect(eventIds).toContain(result.id);
		expect(userIds).toContain(result.id);
		expect(pairIds).toContain(result.id);
	});

	it('records photographed country badge progress when EXIF GPS can be reverse-geocoded', async () => {
		const kv = new MockKVNamespace();
		const bindings = createMockBindings({ KV: kv as any });
		const pending: Promise<unknown>[] = [];
		const ctx = {
			waitUntil: (promise: Promise<unknown>) => {
				pending.push(Promise.resolve(promise));
			}
		};

		mockExifLoad.mockReturnValueOnce({
			GPSLatitude: { value: '37.7749' },
			GPSLongitude: { value: '-122.4194' }
		} as any);
		mockReverseGeocode.mockResolvedValueOnce({} as any);
		mockExtractCountry.mockReturnValueOnce('United States');

		await submitEventImage(101n, 202n, new Uint8Array([1, 2, 3]), bindings, ctx as any);
		await Promise.all(pending);

		expect(mockAddBadgeProgress).toHaveBeenCalledWith(
			'202',
			'event_countries_photographed',
			'united_states',
			bindings.KV
		);
	});
});

describe('getEventImage', () => {
	it('returns null tuple when mapping key is absent', async () => {
		const bindings = createMockBindings();
		const result = await getEventImage('missing', bindings);
		expect(result).toEqual([null, null, null, null]);
	});

	it('returns decrypted image and metadata for stored submissions', async () => {
		const kv = new MockKVNamespace();
		const bindings = createMockBindings({ KV: kv as any });
		const pending: Promise<unknown>[] = [];
		const ctx = {
			waitUntil: (promise: Promise<unknown>) => {
				pending.push(Promise.resolve(promise));
			}
		};

		const submitted = await submitEventImage(
			15n,
			25n,
			new Uint8Array([9, 8, 7, 6]),
			bindings,
			ctx as any
		);
		await Promise.all(pending);

		const [image, eventId, userId, timestamp] = await getEventImage(submitted.id, bindings);

		expect(image).toEqual(new Uint8Array([9, 8, 7, 6]));
		expect(eventId).toBe(15n);
		expect(userId).toBe(25n);
		expect(typeof timestamp).toBe('number');
	});

	it('returns null tuple when submission mapping exists but R2 object is missing', async () => {
		const kv = new MockKVNamespace();
		const bindings = createMockBindings({ KV: kv as any });

		await kv.put('event:submission:orphaned', 'events/1/submissions/2_orphaned.webp', {
			metadata: { eventId: '1', userId: '2', timestamp: Date.now() }
		});

		const result = await getEventImage('orphaned', bindings);
		expect(result).toEqual([null, null, null, null]);
	});
});

describe('deleteEventImageSubmissions', () => {
	it('returns immediately when no filter is provided', async () => {
		const bindings = createMockBindings();
		await expect(
			deleteEventImageSubmissions(null, null, bindings, { waitUntil: () => {} } as any)
		).resolves.toBeUndefined();
	});

	it('deletes submissions for event-user intersections', async () => {
		const kv = new MockKVNamespace();
		const bindings = createMockBindings({ KV: kv as any });
		const pending: Promise<unknown>[] = [];
		const ctx = {
			waitUntil: (promise: Promise<unknown>) => {
				pending.push(Promise.resolve(promise));
			}
		};

		await kv.put('event:submission:keepme', 'events/1/submissions/2_keepme.webp', {
			metadata: { eventId: '1', userId: '2', timestamp: Date.now() }
		});
		await kv.put('event:submission:deleteme', 'events/1/submissions/2_deleteme.webp', {
			metadata: { eventId: '1', userId: '2', timestamp: Date.now() }
		});
		await kv.put('event:1:submission_ids', JSON.stringify(['deleteme']));
		await kv.put('user:2:submission_ids', JSON.stringify(['deleteme']));
		await kv.put('event:1:user:2:submission_ids', JSON.stringify(['deleteme']));
		await bindings.R2.put('events/1/submissions/2_deleteme.webp', new Uint8Array([1, 1, 1]));

		await deleteEventImageSubmissions(1n, 2n, bindings, ctx as any);
		await Promise.all(pending);

		expect(await kv.get('event:submission:deleteme')).toBeNull();
		expect((bindings.R2 as any).has('events/1/submissions/2_deleteme.webp')).toBe(false);
	});

	it('deletes all submissions for an event-only filter', async () => {
		const kv = new MockKVNamespace();
		const bindings = createMockBindings({ KV: kv as any });
		const pending: Promise<unknown>[] = [];
		const ctx = {
			waitUntil: (promise: Promise<unknown>) => {
				pending.push(Promise.resolve(promise));
			}
		};

		await kv.put('event:submission:eventonly', 'events/3/submissions/9_eventonly.webp', {
			metadata: { eventId: '3', userId: '9', timestamp: Date.now() }
		});
		await kv.put('event:3:submission_ids', JSON.stringify(['eventonly']));

		await deleteEventImageSubmissions(3n, null, bindings, ctx as any);
		await Promise.all(pending);

		expect(await kv.get('event:submission:eventonly')).toBeNull();
		expect(await kv.get('event:3:submission_ids')).toBeNull();
	});

	it('deletes all submissions for a user-only filter', async () => {
		const kv = new MockKVNamespace();
		const bindings = createMockBindings({ KV: kv as any });
		const pending: Promise<unknown>[] = [];
		const ctx = {
			waitUntil: (promise: Promise<unknown>) => {
				pending.push(Promise.resolve(promise));
			}
		};

		await kv.put('event:submission:useronly', 'events/4/submissions/8_useronly.webp', {
			metadata: { eventId: '4', userId: '8', timestamp: Date.now() }
		});
		await kv.put('user:8:submission_ids', JSON.stringify(['useronly']));

		await deleteEventImageSubmissions(null, 8n, bindings, ctx as any);
		await Promise.all(pending);

		expect(await kv.get('event:submission:useronly')).toBeNull();
		expect(await kv.get('user:8:submission_ids')).toBeNull();
	});
});

describe('getEventImageSubmissionsWithData', () => {
	it('returns empty array when no eventId and userId are provided', async () => {
		const bindings = createMockBindings({ CACHE: new MockKVNamespace() as any });
		const result = await getEventImageSubmissionsWithData(null, null, bindings);
		expect(result).toEqual([]);
	});

	it('returns paginated, searchable submissions with score metadata', async () => {
		const kv = new MockKVNamespace();
		const cache = new MockKVNamespace();
		const bindings = createMockBindings({ KV: kv as any, CACHE: cache as any });

		const pending: Promise<unknown>[] = [];
		const ctx = {
			waitUntil: (promise: Promise<unknown>) => {
				pending.push(Promise.resolve(promise));
			}
		};

		const first = await submitEventImage(
			50n,
			60n,
			new Uint8Array([10, 11, 12]),
			bindings,
			ctx as any
		);
		const second = await submitEventImage(
			50n,
			60n,
			new Uint8Array([20, 21, 22]),
			bindings,
			ctx as any
		);
		await Promise.all(pending);

		await kv.put(`event:submission:${first.id}`, `events/50/submissions/60_${first.id}.webp`, {
			metadata: { eventId: '50', userId: '60', timestamp: 1 }
		});
		await kv.put(`event:submission:${second.id}`, `events/50/submissions/60_${second.id}.webp`, {
			metadata: { eventId: '50', userId: '60', timestamp: 2 }
		});

		await kv.put(
			`event:image:score:50:${first.id}`,
			JSON.stringify({ score: 0.8, breakdown: [] }),
			{ metadata: { caption: 'reef life', scored_at: 123456789, user_id: '60' } }
		);
		await kv.put(
			`event:image:score:50:${second.id}`,
			JSON.stringify({ score: 0.9, breakdown: [] }),
			{ metadata: { caption: 'forest walk', scored_at: 123456790, user_id: '60' } }
		);

		const newestFirst = await getEventImageSubmissionsWithData(50n, 60n, bindings, 1, 1, 'desc');
		expect(newestFirst).toHaveLength(1);
		expect(newestFirst[0]?.submission_id).toBe(second.id);

		const oldestFirst = await getEventImageSubmissionsWithData(50n, 60n, bindings, 2, 1, 'asc');
		expect(oldestFirst).toHaveLength(2);
		expect(oldestFirst[0]?.submission_id).toBe(first.id);
		expect(oldestFirst[0]?.image.startsWith('data:image/webp;base64,')).toBe(true);

		const captionSearch = await getEventImageSubmissionsWithData(
			50n,
			60n,
			bindings,
			10,
			1,
			'desc',
			'reef'
		);
		expect(captionSearch).toHaveLength(1);
		expect(captionSearch[0]?.submission_id).toBe(first.id);
		expect(captionSearch[0]?.score?.score).toBe(0.8);
	});

	it('deduplicates duplicate index ids, tolerates malformed score json, and supports random/user-only queries', async () => {
		const kv = new MockKVNamespace();
		const cache = new MockKVNamespace();
		const bindings = createMockBindings({ KV: kv as any, CACHE: cache as any });
		const pending: Promise<unknown>[] = [];
		const ctx = {
			waitUntil: (promise: Promise<unknown>) => {
				pending.push(Promise.resolve(promise));
			}
		};

		const first = await submitEventImage(88n, 99n, new Uint8Array([1, 2, 3]), bindings, ctx as any);
		const second = await submitEventImage(
			88n,
			99n,
			new Uint8Array([4, 5, 6]),
			bindings,
			ctx as any
		);
		await Promise.all(pending);

		await kv.put('event:88:submission_ids', JSON.stringify([first.id, first.id, second.id]));
		await kv.put('user:99:submission_ids', JSON.stringify([first.id, second.id]));

		await kv.put(`event:image:score:88:${first.id}`, '{ this is not valid json }', {
			metadata: { caption: 'broken score blob', scored_at: 10, user_id: '99' }
		});

		await kv.put(
			`event:image:score:88:${second.id}`,
			JSON.stringify({ score: 0.95, breakdown: [] }),
			{ metadata: { caption: 'good score', scored_at: 11, user_id: '99' } }
		);

		const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.3);
		const randomResults = await getEventImageSubmissionsWithData(
			88n,
			null,
			bindings,
			20,
			1,
			'rand'
		);
		expect(randomResults).toHaveLength(2);
		expect(new Set(randomResults.map((item) => item.submission_id))).toEqual(
			new Set([first.id, second.id])
		);
		expect(randomResults.find((item) => item.submission_id === first.id)?.score).toBeUndefined();
		randomSpy.mockRestore();

		const bySubmissionId = await getEventImageSubmissionsWithData(
			88n,
			null,
			bindings,
			20,
			1,
			'desc',
			first.id
		);
		expect(bySubmissionId).toHaveLength(1);
		expect(bySubmissionId[0]?.submission_id).toBe(first.id);

		const userOnly = await getEventImageSubmissionsWithData(null, 99n, bindings, 20, 1, 'desc');
		expect(userOnly).toHaveLength(2);
	});
});
