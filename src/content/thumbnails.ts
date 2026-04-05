// event thumbnails
import { Bindings, ExecutionCtxLike } from '../util/types';
import { streamToUint8Array } from '../util/util';
import { findPlaceThumbnail } from '../util/maps';

export type BirthdayPossessive = "'s" | "'";

export type ParsedBirthdayEventName = {
	rawLocationName: string;
	searchLocationName: string;
	possessive: BirthdayPossessive | null;
	hasOrdinal: boolean;
};

export async function uploadPlaceThumbnail(
	name: string,
	eventId: bigint,
	bindings: Bindings,
	ctx: ExecutionCtxLike
): Promise<[Uint8Array | null, string | null]> {
	const cleanedName = name.trim();
	if (!cleanedName) {
		console.warn('Cannot generate event thumbnail: empty place name', { eventId });
		return [null, null];
	}

	const [image0, author] = await findPlaceThumbnail(cleanedName, bindings);
	if (!image0) {
		console.warn('No thumbnail image found for event place', { name: cleanedName, eventId });
		return [null, null];
	}
	if (image0.length === 0) {
		console.warn('Generated thumbnail image was empty', { name: cleanedName, eventId });
		return [null, null];
	}

	const safeAuthor = author?.trim() || 'Unknown';
	const storedImage = await uploadEventThumbnail(eventId, image0, safeAuthor, bindings, ctx);

	return [storedImage, safeAuthor];
}

export function parseBirthdayEventName(eventName: string): ParsedBirthdayEventName | null {
	const normalizedEventName = eventName
		.replace(/&apos;|&#39;|&#x27;/gi, "'")
		.replace(/[\u2019\u2018\u02BC]/g, "'")
		.trim()
		.replace(/\s+/g, ' ');
	if (!normalizedEventName) {
		return null;
	}

	// Match: "Location's Birthday", "Location' Birthday", "Location's 158th Birthday"
	// and normalized variants where apostrophes were stripped ("Location s 158th Birthday").
	const birthdayMatch = normalizedEventName.match(
		/^(.+?)(?:('s|'|\s+s))?(?:\s+(\d+(?:st|nd|rd|th)))?\s+Birthday$/i
	);
	if (!birthdayMatch || !birthdayMatch[1]) {
		return null;
	}
	if (!birthdayMatch[2] && !birthdayMatch[3]) {
		return null;
	}

	const rawLocationName = birthdayMatch[1].trim().replace(/\s+/g, ' ');
	if (!rawLocationName || !/[\p{L}\p{N}]/u.test(rawLocationName)) {
		return null;
	}

	const searchLocationName = rawLocationName
		.replace(/\s*\(([^)]+)\)\s*/g, ', $1')
		.replace(/\s*,\s*/g, ', ')
		.replace(/\s+/g, ' ')
		.replace(/^[,\s]+|[,\s]+$/g, '')
		.trim();
	if (!searchLocationName || !/[\p{L}\p{N}]/u.test(searchLocationName)) {
		return null;
	}

	const possessiveToken = birthdayMatch[2]?.toLowerCase();
	let possessive: BirthdayPossessive | null = null;
	if (possessiveToken === "'s" || possessiveToken === ' s') {
		possessive = "'s";
	} else if (possessiveToken === "'") {
		possessive = "'";
	}

	return {
		rawLocationName,
		searchLocationName,
		possessive,
		hasOrdinal: Boolean(birthdayMatch[3])
	};
}

/**
 * Extracts the searchable location name from a full event name.
 * Works for birthday events with possessive forms like "'s Birthday", "' Birthday",
 * and ordinal variants (e.g., "'s 158th Birthday").
 * Converts parenthetical state/country codes to comma format for better disambiguation.
 * @param eventName - Full event name (e.g., "Springfield (IL)'s Birthday", "Vallejo's 158th Birthday")
 * @returns Searchable location name (e.g., "Springfield, IL", "Vallejo") or null if not a birthday event
 */
export function extractLocationFromEventName(eventName: string): string | null {
	const parsed = parseBirthdayEventName(eventName);
	return parsed?.searchLocationName || null;
}

export async function deleteEventThumbnail(
	eventId: bigint,
	bindings: Bindings,
	ctx: ExecutionCtxLike
) {
	const thumbnailPath = `events/${eventId}/thumbnail.webp`;
	const deletion = Promise.all([
		bindings.R2.delete(thumbnailPath),
		bindings.KV.delete(`event:${eventId}:thumbnail:author`)
	]);
	ctx.waitUntil(deletion);
	await deletion;
}

export async function uploadEventThumbnail(
	eventId: bigint,
	image: Uint8Array,
	author: string,
	bindings: Bindings,
	ctx: ExecutionCtxLike,
	convertToWebP = true
): Promise<Uint8Array> {
	if (image.length === 0) {
		throw new Error('Event thumbnail image cannot be empty');
	}

	let image0 = image;
	if (convertToWebP) {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(image);
				controller.close();
			}
		});

		let transformedStream: ReadableStream;
		try {
			transformedStream = (
				await bindings.IMAGES.input(stream)
					.transform({ height: 720, fit: 'scale-down' })
					.output({ format: 'image/webp', quality: 80 })
			).image();
		} catch (err) {
			console.error('Failed to transform event thumbnail image to webp', { eventId, err });
			throw new Error('Failed to transform event thumbnail image');
		}

		image0 = await streamToUint8Array(transformedStream);
		if (image0.length === 0) {
			throw new Error('Transformed event thumbnail image was empty');
		}
	}

	const thumbnailPath = `events/${eventId}/thumbnail.webp`;
	const upload = Promise.all([
		bindings.R2.put(thumbnailPath, image0, {
			httpMetadata: { contentType: 'image/webp' }
		}),
		bindings.KV.put(`event:${eventId}:thumbnail:author`, author)
	]);
	ctx.waitUntil(upload);
	await upload;

	return image0;
} // event thumbnails

export async function getEventThumbnail(
	eventId: bigint,
	bindings: Bindings
): Promise<[Uint8Array | null, string | null]> {
	const thumbnailPath = `events/${eventId}/thumbnail.webp`;
	const [obj, rawAuthor] = await Promise.all([
		bindings.R2.get(thumbnailPath),
		bindings.KV.get(`event:${eventId}:thumbnail:author`)
	]);

	if (obj) {
		const buf = await obj.arrayBuffer();
		if (buf.byteLength === 0) {
			console.warn('Stored event thumbnail was empty', { eventId, thumbnailPath });
			return [null, null];
		}

		const author = rawAuthor?.trim() || null;
		return [new Uint8Array(buf), author];
	}

	return [null, null];
}
