import { describe, expect, it, vi } from 'vitest';
import {
	deleteEventThumbnail,
	extractLocationFromEventName,
	getEventThumbnail,
	parseBirthdayEventName,
	uploadEventThumbnail,
	uploadPlaceThumbnail
} from '../../src/content/thumbnails';
import { env } from 'cloudflare:workers';
import { type Bindings, type ExecutionCtxLike } from '../../src/util/types';

function createBindings(): Bindings {
	return {
		...env,
		NCBI_API_KEY: 'ncbi'
	} as unknown as Bindings;
}

function createCtx(): ExecutionCtxLike {
	return {
		waitUntil: (_promise: Promise<unknown>) => {}
	};
}

describe('parseBirthdayEventName', () => {
	it('parses possessive birthday names with ordinals', () => {
		const parsed = parseBirthdayEventName("Vallejo's 173rd Birthday");
		expect(parsed?.rawLocationName).toBe('Vallejo');
		expect(parsed?.searchLocationName).toBe('Vallejo');
		expect(parsed?.possessive).toBe("'s");
		expect(parsed?.hasOrdinal).toBe(true);
	});

	it('parses trailing-apostrophe possessive birthday names', () => {
		const parsed = parseBirthdayEventName("Bahamas' Birthday");
		expect(parsed?.rawLocationName).toBe('Bahamas');
		expect(parsed?.searchLocationName).toBe('Bahamas');
		expect(parsed?.possessive).toBe("'");
		expect(parsed?.hasOrdinal).toBe(false);
	});

	it('normalizes HTML apostrophe entities', () => {
		const parsed = parseBirthdayEventName('Raleigh (NC)&apos;s Birthday');
		expect(parsed?.rawLocationName).toBe('Raleigh (NC)');
		expect(parsed?.searchLocationName).toBe('Raleigh, NC');
		expect(parsed?.possessive).toBe("'s");
	});

	it('rejects names without possessive or ordinal marker', () => {
		expect(parseBirthdayEventName('Global Birthday')).toBeNull();
		expect(parseBirthdayEventName('Birthday Celebration')).toBeNull();
	});

	it('returns null for non-birthday names', () => {
		expect(parseBirthdayEventName('Community Cleanup Day')).toBeNull();
	});
});

describe('extractLocationFromEventName', () => {
	it('normalizes parenthetical disambiguators', () => {
		expect(extractLocationFromEventName("Springfield (IL)'s Birthday")).toBe('Springfield, IL');
	});

	it('supports trailing-apostrophe birthday names', () => {
		expect(extractLocationFromEventName("Bahamas' Birthday")).toBe('Bahamas');
	});
});

describe('uploadPlaceThumbnail', () => {
	it('returns null tuple for empty place names', async () => {
		const [image, author] = await uploadPlaceThumbnail('   ', 1n, createBindings(), createCtx());
		expect(image).toBeNull();
		expect(author).toBeNull();
	});
});

describe('uploadEventThumbnail', () => {
	it('stores non-empty image bytes without conversion when disabled', async () => {
		const bindings = createBindings();
		const data = new Uint8Array([1, 2, 3, 4]);
		const stored = await uploadEventThumbnail(1001n, data, 'Tester', bindings, createCtx(), false);
		expect(Array.from(stored)).toEqual([1, 2, 3, 4]);
	});

	it('throws for empty image payloads', async () => {
		await expect(
			uploadEventThumbnail(1002n, new Uint8Array(), 'Tester', createBindings(), createCtx(), false)
		).rejects.toThrow('Event thumbnail image cannot be empty');
	});
});

describe('getEventThumbnail', () => {
	it('retrieves previously uploaded thumbnail + author', async () => {
		const bindings = createBindings();
		await uploadEventThumbnail(
			2001n,
			new Uint8Array([8, 9]),
			'Author',
			bindings,
			createCtx(),
			false
		);
		const [image, author] = await getEventThumbnail(2001n, bindings);

		expect(Array.from(image || [])).toEqual([8, 9]);
		expect(author).toBe('Author');
	});

	it('treats empty stored object as missing thumbnail', async () => {
		const bindings = createBindings();
		await bindings.R2.put('events/2002/thumbnail.webp', new Uint8Array());
		await bindings.KV.put('event:2002:thumbnail:author', 'Author');

		const [image, author] = await getEventThumbnail(2002n, bindings);
		expect(image).toBeNull();
		expect(author).toBeNull();
	});
});

describe('deleteEventThumbnail', () => {
	it('removes thumbnail object and author metadata', async () => {
		const bindings = createBindings();
		await uploadEventThumbnail(3001n, new Uint8Array([7]), 'Author', bindings, createCtx(), false);
		await deleteEventThumbnail(3001n, bindings, createCtx());

		const [image, author] = await getEventThumbnail(3001n, bindings);
		expect(image).toBeNull();
		expect(author).toBeNull();
	});
});
