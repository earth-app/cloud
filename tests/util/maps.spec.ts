import { afterEach, describe, expect, it, vi } from 'vitest';
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
		const searchBody = { places: [{ name: 'places/abc' }] };
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
});
