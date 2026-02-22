import { Bindings } from './types';

// returns [imageData, authorName]
export async function findPlaceThumbnail(
	name: string,
	bindings: Bindings
): Promise<[Uint8Array | null, string | null]> {
	const cleanedName = name.replace(/\s*\(([^)]+)\)\s*/g, ', $1').trim();

	const search = await fetch('https://places.googleapis.com/v1/places:searchText', {
		method: 'POST',
		body: JSON.stringify({
			textQuery: cleanedName,
			includedType: 'locality',
			maxResultCount: 1
		}),
		headers: {
			'Content-Type': 'application/json',
			'X-Goog-Api-Key': bindings.MAPS_API_KEY,
			'X-Goog-FieldMask': 'places.name'
		}
	});

	if (!search.ok) {
		console.error('Failed to search for place thumbnail', {
			name,
			cleanedName,
			status: search.status,
			statusText: search.statusText,
			body: await search.text()
		});

		throw new Error('Place search request failed');
	}

	const places = await search.json<{ places: { name: string }[] }>();

	if (!places.places || places.places.length === 0) {
		console.warn('No places found for thumbnail search', { name, cleanedName });
		return [null, null];
	}

	const placeName = places.places[0].name;

	const data = await fetch(`https://places.googleapis.com/v1/${placeName}`, {
		method: 'GET',
		headers: {
			'Content-Type': 'application/json',
			'X-Goog-Api-Key': bindings.MAPS_API_KEY,
			'X-Goog-FieldMask': 'photos'
		}
	}).then((res) =>
		res.json<{
			photos: {
				name: string;
				authorAttributions: {
					displayName: string;
				}[];
			}[];
		}>()
	);

	if (!data.photos || data.photos.length === 0) {
		console.warn('No photos found for place thumbnail', { name, placeName });
		return [null, null];
	}

	const { name: photoName, authorAttributions: author } = data.photos[0];

	const photoData = await fetch(
		`https://places.googleapis.com/v1/${photoName}/media?maxHeightPx=720&maxWidthPx=1280&key=${bindings.MAPS_API_KEY}`
	);

	if (!photoData.ok) {
		console.error('Failed to fetch place photo media', {
			name,
			placeName,
			photoName,
			status: photoData.status,
			statusText: photoData.statusText
		});
		return [null, null];
	}

	const blob = await photoData.blob();
	const arrayBuffer = await blob.arrayBuffer();
	return [new Uint8Array(arrayBuffer), author?.[0]?.displayName || null];
}

// geocoding & reverse geocoding

export type ReverseGeocodeResult = {
	address_components: {
		long_name: string;
		short_name: string;
		types: string[];
	}[];
	formatted_address: string;
	geometry: {
		location: {
			lat: number;
			lng: number;
		};
	};
	place_id: string;
	types: string[];
};

export async function reverseGeocode(
	latitude: number,
	longitude: number,
	bindings: Bindings
): Promise<ReverseGeocodeResult[]> {
	const res = await fetch(
		`https://maps.googleapis.com/maps/api/geocode/json?latlng=${latitude},${longitude}&key=${bindings.MAPS_API_KEY}`
	);

	if (!res.ok) {
		console.error('Failed to reverse geocode coordinates', {
			latitude,
			longitude,
			status: res.status,
			statusText: res.statusText,
			body: await res.text()
		});
		throw new Error('Reverse geocoding request failed');
	}

	const data = await res.json<{ results: ReverseGeocodeResult[] }>();
	return data.results;
}

export function getCountry(results: ReverseGeocodeResult[]): string {
	for (const result of results) {
		for (const component of result.address_components) {
			if (component.types.includes('country')) {
				return component.long_name;
			}
		}
	}

	// return falsy value
	return '';
}
