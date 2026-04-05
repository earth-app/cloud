import { describe, expect, it } from 'vitest';
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
});

describe('getEventImage', () => {
	it('returns null tuple when mapping key is absent', async () => {
		const bindings = createMockBindings();
		const result = await getEventImage('missing', bindings);
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
});

describe('getEventImageSubmissionsWithData', () => {
	it('returns empty array when no eventId and userId are provided', async () => {
		const bindings = createMockBindings({ CACHE: new MockKVNamespace() as any });
		const result = await getEventImageSubmissionsWithData(null, null, bindings);
		expect(result).toEqual([]);
	});
});
