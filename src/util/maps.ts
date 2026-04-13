import { Bindings } from './types';

type PlaceSearchResponse = {
	places?: Array<{
		name?: string | null;
		types?: string[] | null;
	}> | null;
};

type PlaceSearchResult = {
	placeName: string | null;
	responseOk: boolean;
};

const VALID_PLACE_TYPES = new Set([
	'locality',
	'postal_town',
	'sublocality',
	'sublocality_level_1',
	'administrative_area_level_1',
	'administrative_area_level_2',
	'administrative_area_level_3',
	'country',
	'political'
]);

function hasValidPlaceType(types: string[] | null | undefined): boolean {
	if (!types || !Array.isArray(types)) {
		return false;
	}

	return types.some((t) => VALID_PLACE_TYPES.has(t));
}

type PlaceDetailsResponse = {
	photos?: Array<{
		name?: string | null;
		authorAttributions?: Array<{
			displayName?: string | null;
		}> | null;
	}> | null;
};

async function searchPlaceName(
	textQuery: string,
	bindings: Bindings,
	includedType?: string
): Promise<PlaceSearchResult> {
	const body: Record<string, unknown> = {
		textQuery,
		maxResultCount: 1
	};
	if (includedType) {
		body.includedType = includedType;
	}

	let search: Response;
	try {
		search = await fetch('https://places.googleapis.com/v1/places:searchText', {
			method: 'POST',
			body: JSON.stringify(body),
			headers: {
				'Content-Type': 'application/json',
				'X-Goog-Api-Key': bindings.MAPS_API_KEY,
				'X-Goog-FieldMask': 'places.name,places.types'
			}
		});
	} catch (err) {
		console.error('Failed to send place thumbnail search request', {
			textQuery,
			includedType,
			err
		});
		return { placeName: null, responseOk: false };
	}

	if (!search.ok) {
		console.error('Failed to search for place thumbnail', {
			textQuery,
			includedType,
			status: search.status,
			statusText: search.statusText,
			body: await search.text()
		});
		return { placeName: null, responseOk: false };
	}

	let places: PlaceSearchResponse;
	try {
		places = await search.json<PlaceSearchResponse>();
	} catch (err) {
		console.error('Failed to parse place thumbnail search response', {
			textQuery,
			includedType,
			err
		});
		return { placeName: null, responseOk: false };
	}

	const firstPlace = places.places?.[0];
	const placeName = firstPlace?.name;
	if (!placeName || typeof placeName !== 'string') {
		return { placeName: null, responseOk: true };
	}

	if (!hasValidPlaceType(firstPlace?.types)) {
		console.warn('Place search result did not resolve to a geographic/political place', {
			textQuery,
			includedType,
			placeName,
			types: firstPlace?.types || []
		});
		return { placeName: null, responseOk: true };
	}

	const normalizedPlaceName = placeName.trim();
	return {
		placeName: normalizedPlaceName.length > 0 ? normalizedPlaceName : null,
		responseOk: true
	};
}

// returns [imageData, authorName]
export async function findPlaceThumbnail(
	name: string,
	bindings: Bindings
): Promise<[Uint8Array | null, string | null]> {
	const cleanedName = name.replace(/\s*\(([^)]+)\)\s*/g, ', $1').trim();
	if (!cleanedName) {
		console.warn('No place name provided for thumbnail search', { name });
		return [null, null];
	}

	if (!bindings.MAPS_API_KEY || bindings.MAPS_API_KEY.trim().length === 0) {
		console.error('MAPS_API_KEY is missing; cannot generate event thumbnail', {
			name,
			cleanedName
		});
		return [null, null];
	}

	// First try locality (best for city birthdays), then fallback to a broader search
	// for countries/regions where includedType=locality can miss valid places.
	const localitySearch = await searchPlaceName(cleanedName, bindings, 'locality');
	let placeName = localitySearch.placeName;

	// Only widen the search if the locality query succeeded but had no results.
	if (!placeName && localitySearch.responseOk) {
		const broadSearch = await searchPlaceName(cleanedName, bindings);
		placeName = broadSearch.placeName;
	}

	if (!placeName) {
		console.warn('No places found for thumbnail search', { name, cleanedName });
		return [null, null];
	}

	let detailsRes: Response;
	try {
		detailsRes = await fetch(`https://places.googleapis.com/v1/${placeName}`, {
			method: 'GET',
			headers: {
				'Content-Type': 'application/json',
				'X-Goog-Api-Key': bindings.MAPS_API_KEY,
				'X-Goog-FieldMask': 'photos'
			}
		});
	} catch (err) {
		console.error('Failed to fetch place details for thumbnail search', {
			name,
			placeName,
			err
		});
		return [null, null];
	}

	if (!detailsRes.ok) {
		console.error('Failed to fetch place details for thumbnail search', {
			name,
			placeName,
			status: detailsRes.status,
			statusText: detailsRes.statusText,
			body: await detailsRes.text()
		});
		return [null, null];
	}

	let data: PlaceDetailsResponse;
	try {
		data = await detailsRes.json<PlaceDetailsResponse>();
	} catch (err) {
		console.error('Failed to parse place details response for thumbnail search', {
			name,
			placeName,
			err
		});
		return [null, null];
	}

	const firstPhoto = data.photos?.[0];
	if (!firstPhoto || !firstPhoto.name || typeof firstPhoto.name !== 'string') {
		console.warn('No photos found for place thumbnail', { name, placeName });
		return [null, null];
	}

	const photoName = firstPhoto.name;
	const authorName = firstPhoto.authorAttributions?.[0]?.displayName?.trim() || null;

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

	const contentType = photoData.headers.get('Content-Type') || '';
	if (!contentType.startsWith('image/')) {
		console.error('Place photo media response was not an image', {
			name,
			placeName,
			photoName,
			contentType
		});
		return [null, null];
	}

	const arrayBuffer = await photoData.arrayBuffer();
	if (arrayBuffer.byteLength === 0) {
		console.warn('Place photo media response was empty', { name, placeName, photoName });
		return [null, null];
	}

	return [new Uint8Array(arrayBuffer), authorName];
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
	try {
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
			return [];
		}

		const data = await res.json<{ results: ReverseGeocodeResult[] }>();
		return data.results;
	} catch (err) {
		console.error('Failed to fetch or parse reverse geocode response', {
			latitude,
			longitude,
			err
		});
		return [];
	}
}

export function extractCountry(results: ReverseGeocodeResult[]): string {
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

export function extractState(results: ReverseGeocodeResult[]): string {
	for (const result of results) {
		for (const component of result.address_components) {
			if (component.types.includes('administrative_area_level_1')) {
				return component.long_name;
			}
		}
	}

	// return falsy value
	return '';
}

export function extractLocality(results: ReverseGeocodeResult[]): string[] {
	const localities: string[] = [];

	const validTypes = [
		'administrative_area_level_2', // county
		'locality', // city/town
		'sublocality', // district
		'neighborhood' // smaller area within sublocality
	];
	for (const result of results) {
		for (const component of result.address_components) {
			if (component.types.some((type) => validTypes.includes(type))) {
				localities.push(component.long_name);
			}
		}
	}

	return localities;
}
