import { describe, expect, it } from 'vitest';
import {
	createPhotoVariation,
	getProfilePhoto,
	getProfileVariation,
	newProfilePhoto
} from '../../src/user/profile';
import { createMockBindings } from '../helpers/mock-bindings';

describe('getProfilePhoto', () => {
	it('returns cloud fallback for special user id 1', async () => {
		const image = await getProfilePhoto(1n, createMockBindings());
		expect(new TextDecoder().decode(image)).toBe('cloud');
	});

	it('returns default earth image when no profile exists', async () => {
		const image = await getProfilePhoto(999n, createMockBindings());
		expect(new TextDecoder().decode(image)).toBe('earth');
	});
});

describe('getProfileVariation', () => {
	it('returns sized variant when it exists', async () => {
		const bindings = createMockBindings();
		await bindings.R2.put('users/42/profile_32.png', new Uint8Array([4, 4]));

		const image = await getProfileVariation(42n, 32, bindings, { waitUntil: () => {} } as any);
		expect(Array.from(image)).toEqual([4, 4]);
	});

	it('returns original image when requested size is 1024', async () => {
		const bindings = createMockBindings();
		await bindings.R2.put('users/42/profile.png', new Uint8Array([5, 5]));

		const image = await getProfileVariation(42n, 1024, bindings, { waitUntil: () => {} } as any);
		expect(Array.from(image)).toEqual([5, 5]);
	});

	it('returns cloud fallback for special user id 1 even for variations', async () => {
		const bindings = createMockBindings();
		await bindings.R2.put('users/1/profile_32.png', new Uint8Array([4, 4]));

		const image = await getProfileVariation(1n, 32, bindings, { waitUntil: () => {} } as any);
		expect(new TextDecoder().decode(image)).toBe('cloud');
	});

	it('falls back to original image for invalid sizes', async () => {
		const bindings = createMockBindings();
		await bindings.R2.put('users/5/profile.png', new Uint8Array([9, 9]));

		const image = await getProfileVariation(5n, 999 as any, bindings, {
			waitUntil: () => {}
		} as any);
		expect(Array.from(image)).toEqual([9, 9]);
	});

	it('creates a new profile variation when it does not exist', async () => {
		const bindings = createMockBindings();
		await bindings.R2.put('users/5/profile.png', new Uint8Array([9, 9]));

		const image = await getProfileVariation(5n, 32, bindings, { waitUntil: () => {} } as any);
		expect(Array.from(image)).toEqual([9, 9]);
	});
});

describe('createPhotoVariation', () => {
	it('transforms and stores a sized profile variant', async () => {
		const waits: Promise<unknown>[] = [];
		const bindings = createMockBindings();
		const ctx = { waitUntil: (promise: Promise<unknown>) => waits.push(promise) };
		const source = new Uint8Array([1, 2, 3]);

		const transformed = await createPhotoVariation(32, source, 2n, bindings, ctx as any);
		expect(Array.from(transformed)).toEqual([1, 2, 3]);

		await Promise.all(waits);
		const saved = await bindings.R2.get('users/2/profile_32.png');
		expect(saved).not.toBeNull();
	});

	it('returns original image for invalid sizes', async () => {
		const waits: Promise<unknown>[] = [];
		const bindings = createMockBindings();
		const ctx = { waitUntil: (promise: Promise<unknown>) => waits.push(promise) };
		const source = new Uint8Array([1, 2, 3]);

		const transformed = await createPhotoVariation(999 as any, source, 2n, bindings, ctx as any);
		expect(Array.from(transformed)).toEqual([1, 2, 3]);
	});
});

describe('getProfileVariation', () => {
	it('falls back to original image for invalid sizes', async () => {
		const waits: Promise<unknown>[] = [];
		const bindings = createMockBindings();
		const ctx = { waitUntil: (promise: Promise<unknown>) => waits.push(promise) };
		await bindings.R2.put('users/5/profile.png', new Uint8Array([9, 9]));

		const image = await getProfileVariation(5n, 999 as any, bindings, ctx as any);
		expect(Array.from(image)).toEqual([9, 9]);
	});
});

describe('newProfilePhoto', () => {
	it('generates image and schedules variant writes', async () => {
		const waits: Promise<unknown>[] = [];
		const bindings = createMockBindings({
			AI: {
				run: async () =>
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new Uint8Array([7, 8]));
							controller.close();
						}
					})
			} as any
		});
		const ctx = { waitUntil: (promise: Promise<unknown>) => waits.push(promise) };

		const profile = await newProfilePhoto(
			{
				username: 'earthy',
				bio: 'bio',
				created_at: '2026-01-01',
				visibility: 'PUBLIC' as any,
				country: 'US',
				full_name: 'Earth User',
				activities: []
			},
			11n,
			bindings,
			ctx as any
		);

		expect(Array.from(profile)).toEqual([7, 8]);
		await Promise.all(waits);

		expect(await bindings.R2.get('users/11/profile.png')).not.toBeNull();
		expect(await bindings.R2.get('users/11/profile_128.png')).not.toBeNull();
		expect(await bindings.R2.get('users/11/profile_32.png')).not.toBeNull();
	});
});
