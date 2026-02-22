// event thumbnails
import { Bindings } from '../util/types';
import { streamToUint8Array } from '../util/util';
import { findPlaceThumbnail } from '../util/maps';
import { ExecutionContext } from '@cloudflare/workers-types';

export async function uploadPlaceThumbnail(
	name: string,
	eventId: bigint,
	bindings: Bindings,
	ctx: ExecutionContext
): Promise<[Uint8Array | null, string | null]> {
	const [image0, author] = await findPlaceThumbnail(name, bindings);
	if (!image0) {
		console.warn('No thumbnail image found for event place', { name, eventId });
		return [null, null];
	}

	await uploadEventThumbnail(eventId, image0, author || 'Unknown', bindings, ctx);

	return [image0, author || 'Unknown'];
}

/**
 * Extracts the searchable location name from a full event name.
 * Only works for birthday events (names ending with "'s Birthday" or "'s [ordinal] Birthday").
 * Converts parenthetical state/country codes to comma format for better disambiguation.
 * @param eventName - Full event name (e.g., "Springfield (IL)'s Birthday", "Vallejo's 158th Birthday")
 * @returns Searchable location name (e.g., "Springfield, IL", "Vallejo") or null if not a birthday event
 */
export function extractLocationFromEventName(eventName: string): string | null {
	// Match: "Location's Birthday" or "Location's 158th Birthday"
	// Capture group 1: the location name (non-greedy)
	// Optional non-capturing group: ordinal number like "158th"
	// Accept both possessive forms: "'s" (e.g., "O'Fallon's") and just trailing "'"
	// (e.g., "Minneapolis' 128th Birthday"). Also accept curly apostrophe (\u2019).
	const birthdayMatch = eventName.match(
		/^(.+?)(?:['\u2019]s|['\u2019])(?:\s+\d+(?:st|nd|rd|th))?\s+Birthday$/i
	);
	if (!birthdayMatch || !birthdayMatch[1]) {
		return null;
	}

	const locationName = birthdayMatch[1].trim();

	// Convert parenthetical state/country codes to comma format
	// e.g., "Arlington (TX)" -> "Arlington, TX" for better place disambiguation
	// e.g., "Springfield (IL)" -> "Springfield, IL"
	return locationName.replace(/\s*\(([^)]+)\)\s*/g, ', $1').trim();
}

export async function deleteEventThumbnail(
	eventId: bigint,
	bindings: Bindings,
	ctx: ExecutionContext
) {
	const thumbnailPath = `events/${eventId}/thumbnail.webp`;
	ctx.waitUntil(
		Promise.allSettled([
			bindings.R2.delete(thumbnailPath),
			bindings.KV.delete(`event:${eventId}:thumbnail:author`)
		])
	);
}

export async function uploadEventThumbnail(
	eventId: bigint,
	image: Uint8Array,
	author: string,
	bindings: Bindings,
	ctx: ExecutionContext,
	convertToWebP = true
) {
	let image0 = image;
	if (convertToWebP) {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(image);
				controller.close();
			}
		});

		const transformedStream = (
			await bindings.IMAGES.input(stream)
				.transform({ height: 720, fit: 'scale-down' })
				.output({ format: 'image/webp', quality: 80 })
		).image();

		image0 = await streamToUint8Array(transformedStream);
	}

	const thumbnailPath = `events/${eventId}/thumbnail.webp`;
	ctx.waitUntil(
		Promise.allSettled([
			bindings.R2.put(thumbnailPath, image0, {
				httpMetadata: { contentType: 'image/webp' }
			}),
			bindings.KV.put(`event:${eventId}:thumbnail:author`, author)
		])
	);
} // event thumbnails

export async function getEventThumbnail(
	eventId: bigint,
	bindings: Bindings
): Promise<[Uint8Array | null, string | null]> {
	const thumbnailPath = `events/${eventId}/thumbnail.webp`;
	const [obj, author] = await Promise.all([
		bindings.R2.get(thumbnailPath),
		bindings.KV.get(`event:${eventId}:thumbnail:author`)
	]);

	if (obj) {
		const buf = await obj.arrayBuffer();
		return [new Uint8Array(buf), author];
	}

	return [null, null];
}
