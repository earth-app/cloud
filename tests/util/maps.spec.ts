import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/util/maps', async () => {
	const actual = await vi.importActual<typeof import('../../src/util/maps')>('../../src/util/maps');
	return actual;
});

import {
	extractCountry,
	extractLocality,
	extractState,
	findPlaceThumbnail,
	reverseGeocode,
	type ReverseGeocodeResult
} from '../../src/util/maps';
import { type Bindings } from '../../src/util/types';

function createBindings(): Bindings {
	return {
		R2: {} as R2Bucket,
		AI: {} as Ai,
		KV: {} as KVNamespace,
		CACHE: {} as KVNamespace,
		ASSETS: {} as Fetcher,
		IMAGES: {} as ImagesBinding,
		NOTIFIER: {} as DurableObjectNamespace,
		TIMER: {} as DurableObjectNamespace,
		ADMIN_API_KEY: 'admin',
		NCBI_API_KEY: 'ncbi',
		MANTLE_URL: 'https://api.earth-app.com',
		MAPS_API_KEY: 'maps-key',
		ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('findPlaceThumbnail', () => {
	it('returns image bytes and author for successful place lookup flow', async () => {
		const searchBody = { places: [{ name: 'places/abc', types: ['locality', 'political'] }] };
		const detailsBody = {
			photos: [{ name: 'photos/1', authorAttributions: [{ displayName: 'Author A' }] }]
		};
		const imageBytes = new Uint8Array([1, 2, 3, 4]);

		vi.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(new Response(JSON.stringify(searchBody), { status: 200 }))
			.mockResolvedValueOnce(new Response(JSON.stringify(detailsBody), { status: 200 }))
			.mockResolvedValueOnce(
				new Response(imageBytes, {
					status: 200,
					headers: { 'Content-Type': 'image/webp' }
				})
			);

		const [image, author] = await findPlaceThumbnail('Vallejo (CA)', createBindings());
		expect(Array.from(image || [])).toEqual([1, 2, 3, 4]);
		expect(author).toBe('Author A');
	});

	it('returns null tuple when maps key is missing', async () => {
		const bindings = createBindings();
		bindings.MAPS_API_KEY = '';
		const result = await findPlaceThumbnail('Vallejo', bindings);
		expect(result).toEqual([null, null]);
	});

	it('returns null tuple if response json parsing fails', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response('invalid json', { status: 200 })
		);

		const result = await findPlaceThumbnail('Vallejo', createBindings());
		expect(result).toEqual([null, null]);
	});

	it('falls back when locality search resolves to a non-place type', async () => {
		const localityNonPlace = { places: [{ name: 'places/business', types: ['establishment'] }] };
		const broadPlace = { places: [{ name: 'places/abc', types: ['country', 'political'] }] };
		const detailsBody = {
			photos: [{ name: 'photos/1', authorAttributions: [{ displayName: 'Author A' }] }]
		};
		const imageBytes = new Uint8Array([1, 2, 3]);

		vi.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(new Response(JSON.stringify(localityNonPlace), { status: 200 }))
			.mockResolvedValueOnce(new Response(JSON.stringify(broadPlace), { status: 200 }))
			.mockResolvedValueOnce(new Response(JSON.stringify(detailsBody), { status: 200 }))
			.mockResolvedValueOnce(
				new Response(imageBytes, {
					status: 200,
					headers: { 'Content-Type': 'image/webp' }
				})
			);

		const [image, author] = await findPlaceThumbnail('Apple Inc', createBindings());
		expect(Array.from(image || [])).toEqual([1, 2, 3]);
		expect(author).toBe('Author A');
	});

	it('returns null tuple when search results are non-place entity types', async () => {
		const localityNonPlace = { places: [{ name: 'places/business', types: ['establishment'] }] };
		const broadNonPlace = { places: [{ name: 'places/poi', types: ['point_of_interest'] }] };

		vi.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(new Response(JSON.stringify(localityNonPlace), { status: 200 }))
			.mockResolvedValueOnce(new Response(JSON.stringify(broadNonPlace), { status: 200 }));

		const result = await findPlaceThumbnail('Acme Corporation', createBindings());
		expect(result).toEqual([null, null]);
	});

	it('returns null tuple if search request fails', async () => {
		vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network error'));

		const result = await findPlaceThumbnail('Vallejo', createBindings());
		expect(result).toEqual([null, null]);
	});

	it('returns null tuple when no places found', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(JSON.stringify({ places: [] }), { status: 200 })
		);

		const result = await findPlaceThumbnail('Vallejo', createBindings());
		expect(result).toEqual([null, null]);
	});

	it('returns null tuple when no photos found', async () => {
		const searchBody = { places: [{ name: 'places/abc', types: ['locality'] }] };
		const detailsBody = { photos: [] };

		vi.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(new Response(JSON.stringify(searchBody), { status: 200 }))
			.mockResolvedValueOnce(new Response(JSON.stringify(detailsBody), { status: 200 }));

		const result = await findPlaceThumbnail('Vallejo', createBindings());
		expect(result).toEqual([null, null]);
	});

	it('returns null tuple when photo fetch fails', async () => {
		const searchBody = { places: [{ name: 'places/abc', types: ['locality'] }] };
		const detailsBody = {
			photos: [{ name: 'photos/1', authorAttributions: [{ displayName: 'Author A' }] }]
		};

		vi.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(new Response(JSON.stringify(searchBody), { status: 200 }))
			.mockResolvedValueOnce(new Response(JSON.stringify(detailsBody), { status: 200 }))
			.mockResolvedValueOnce(new Response(null, { status: 404 }));

		const result = await findPlaceThumbnail('Vallejo', createBindings());
		expect(result).toEqual([null, null]);
	});

	it('returns null tuple when photo fetch returns non-image content type', async () => {
		const searchBody = { places: [{ name: 'places/abc', types: ['locality'] }] };
		const detailsBody = {
			photos: [{ name: 'photos/1', authorAttributions: [{ displayName: 'Author A' }] }]
		};

		vi.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(new Response(JSON.stringify(searchBody), { status: 200 }))
			.mockResolvedValueOnce(new Response(JSON.stringify(detailsBody), { status: 200 }))
			.mockResolvedValueOnce(
				new Response(null, {
					status: 200,
					headers: { 'Content-Type': 'text/html' }
				})
			);

		const result = await findPlaceThumbnail('Vallejo', createBindings());
		expect(result).toEqual([null, null]);
	});

	it('returns null tuple when photo fetch returns empty body', async () => {
		const searchBody = { places: [{ name: 'places/abc', types: ['locality'] }] };
		const detailsBody = {
			photos: [{ name: 'photos/1', authorAttributions: [{ displayName: 'Author A' }] }]
		};

		vi.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(new Response(JSON.stringify(searchBody), { status: 200 }))
			.mockResolvedValueOnce(new Response(JSON.stringify(detailsBody), { status: 200 }))
			.mockResolvedValueOnce(
				new Response(new Uint8Array([]), {
					status: 200,
					headers: { 'Content-Type': 'image/webp' }
				})
			);

		const result = await findPlaceThumbnail('Vallejo', createBindings());
		expect(result).toEqual([null, null]);
	});

	it('returns null tuple when photo has no bytes', async () => {
		const searchBody = { places: [{ name: 'places/abc', types: ['locality'] }] };
		const detailsBody = {
			photos: [{ name: 'photos/1', authorAttributions: [{ displayName: 'Author A' }] }]
		};

		vi.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(new Response(JSON.stringify(searchBody), { status: 200 }))
			.mockResolvedValueOnce(new Response(JSON.stringify(detailsBody), { status: 200 }))
			.mockResolvedValueOnce(
				new Response(null, {
					status: 200,
					headers: { 'Content-Type': 'image/webp' }
				})
			);

		const result = await findPlaceThumbnail('Vallejo', createBindings());
		expect(result).toEqual([null, null]);
	});
});

describe('reverseGeocode', () => {
	it('returns parsed geocode results', async () => {
		const payload = {
			results: [
				{
					address_components: [],
					formatted_address: 'Test',
					geometry: { location: { lat: 1, lng: 2 } },
					place_id: 'x',
					types: ['locality']
				}
			]
		};
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(JSON.stringify(payload), { status: 200 })
		);

		const result = await reverseGeocode(1, 2, createBindings());
		expect(result).toHaveLength(1);
	});

	it('returns empty array on fetch failure', async () => {
		vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network error'));

		const result = await reverseGeocode(1, 2, createBindings());
		expect(result).toEqual([]);
	});

	it('returns empty array on json parsing failure', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response('invalid json', { status: 200 })
		);

		const result = await reverseGeocode(1, 2, createBindings());
		expect(result).toEqual([]);
	});
});

describe('extractCountry', () => {
	it('extracts the first country component', () => {
		const results = [
			{
				address_components: [{ long_name: 'United States', short_name: 'US', types: ['country'] }],
				formatted_address: '',
				geometry: { location: { lat: 0, lng: 0 } },
				place_id: '1',
				types: []
			}
		] as ReverseGeocodeResult[];

		expect(extractCountry(results)).toBe('United States');
	});

	it('returns empty string if no country component found', () => {
		const results = [
			{
				address_components: [
					{ long_name: 'California', short_name: 'CA', types: ['administrative_area_level_1'] }
				],
				formatted_address: '',
				geometry: { location: { lat: 0, lng: 0 } },
				place_id: '1',
				types: []
			}
		] as ReverseGeocodeResult[];

		expect(extractCountry(results)).toBe('');
	});
});

describe('extractState', () => {
	it('extracts first admin level 1 component', () => {
		const results = [
			{
				address_components: [
					{ long_name: 'California', short_name: 'CA', types: ['administrative_area_level_1'] }
				],
				formatted_address: '',
				geometry: { location: { lat: 0, lng: 0 } },
				place_id: '1',
				types: []
			}
		] as ReverseGeocodeResult[];

		expect(extractState(results)).toBe('California');
	});

	it('returns empty string if no admin level 1 component found', () => {
		const results = [
			{
				address_components: [{ long_name: 'United States', short_name: 'US', types: ['country'] }],
				formatted_address: '',
				geometry: { location: { lat: 0, lng: 0 } },
				place_id: '1',
				types: []
			}
		] as ReverseGeocodeResult[];

		expect(extractState(results)).toBe('');
	});
});

describe('extractLocality', () => {
	it('extracts locality-related components', () => {
		const results = [
			{
				address_components: [
					{ long_name: 'Vallejo', short_name: 'Vallejo', types: ['locality'] },
					{
						long_name: 'Solano County',
						short_name: 'Solano',
						types: ['administrative_area_level_2']
					}
				],
				formatted_address: '',
				geometry: { location: { lat: 0, lng: 0 } },
				place_id: '1',
				types: []
			}
		] as ReverseGeocodeResult[];

		expect(extractLocality(results)).toEqual(['Vallejo', 'Solano County']);
	});

	it('returns empty array if no locality-related components found', () => {
		const results = [
			{
				address_components: [{ long_name: 'United States', short_name: 'US', types: ['country'] }],
				formatted_address: '',
				geometry: { location: { lat: 0, lng: 0 } },
				place_id: '1',
				types: []
			}
		] as ReverseGeocodeResult[];

		expect(extractLocality(results)).toEqual([]);
	});
});
