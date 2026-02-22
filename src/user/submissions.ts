import { ExecutionContext, KVNamespace } from '@cloudflare/workers-types';
import { Bindings } from '../util/types';
import {
	normalizeId,
	streamToUint8Array,
	encryptImage,
	batchProcess,
	decryptImage,
	toDataURL
} from '../util/util';
import { ScoreResult } from '../content/ferry';
import { tryCache } from '../util/cache';
import ExifReader from 'exifreader';
import { getCountry as extractCountry, reverseGeocode } from '../util/maps';
import { addBadgeProgress } from './badges';

// Helper functions for managing submission ID indices

export async function addSubmissionToIndex(
	indexKey: string,
	submissionId: string,
	timestamp: number,
	bindings: KVNamespace
): Promise<void> {
	const existing = await bindings.get<string[]>(indexKey, 'json');
	const ids = existing || [];

	// Avoid duplicates
	if (!ids.includes(submissionId)) {
		ids.push(submissionId);
		await bindings.put(indexKey, JSON.stringify(ids), {
			metadata: { last_updated: timestamp },
			expirationTtl: 60 * 60 * 24 * 90 // 90 days - cleanup old indices
		});
	} else {
		// Refresh TTL even if duplicate (bumps expiration)
		await bindings.put(indexKey, JSON.stringify(ids), {
			metadata: { last_updated: timestamp },
			expirationTtl: 60 * 60 * 24 * 90
		});
	}
}

export async function removeSubmissionFromIndex(
	indexKey: string,
	submissionId: string,
	bindings: KVNamespace
): Promise<void> {
	const existing = await bindings.get<string[]>(indexKey, 'json');
	if (!existing) return;

	const filtered = existing.filter((id) => id !== submissionId);
	if (filtered.length !== existing.length) {
		if (filtered.length === 0) {
			// Clean up empty indices
			await bindings.delete(indexKey);
		} else {
			await bindings.put(indexKey, JSON.stringify(filtered), {
				metadata: { last_updated: Date.now() }
			});
		}
	}
}

// implementation of submission management

export async function submitEventImage(
	eventId: bigint,
	userId: bigint,
	image: Uint8Array,
	bindings: Bindings,
	ctx: ExecutionContext
) {
	if (!eventId || !userId) {
		throw new Error('Event ID and User ID are required for submitting an image');
	}

	if (image.length === 0) {
		throw new Error('Image data cannot be empty');
	}

	const id = crypto.randomUUID().replace(/-/g, '');
	const timestamp = Date.now();
	const imagePath = `events/${eventId}/submissions/${userId}_${id}.webp`;

	// map id to path in KV and add to reverse indices (event, user, and event-user intersection)
	await Promise.all([
		bindings.KV.put(`event:submission:${id}`, imagePath, {
			metadata: {
				eventId: normalizeId(eventId.toString()),
				userId: normalizeId(userId.toString()),
				timestamp
			}
		}),
		addSubmissionToIndex(`event:${eventId}:submission_ids`, id, timestamp, bindings.KV),
		addSubmissionToIndex(`user:${userId}:submission_ids`, id, timestamp, bindings.KV),
		addSubmissionToIndex(
			`event:${eventId}:user:${userId}:submission_ids`,
			id,
			timestamp,
			bindings.KV
		)
	]);

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(image);
			controller.close();
		}
	});

	const transformedStream = (
		await bindings.IMAGES.input(stream)
			.transform({ height: 1080, fit: 'scale-down' })
			.output({ format: 'image/webp', quality: 90 })
	).image();

	const image0 = await streamToUint8Array(transformedStream);

	// Encrypt the image data before storing
	const encryptedImage = await encryptImage(image0, bindings.ENCRYPTION_KEY);

	ctx.waitUntil(
		Promise.all([
			bindings.R2.put(imagePath, encryptedImage, {
				httpMetadata: {
					contentType: 'application/octet-stream' // encrypted data
				}
			}),
			bindings.CACHE.delete(`event:${eventId}:submissions`),
			bindings.CACHE.delete(`user:${userId}:submissions`),
			bindings.CACHE.delete(`event:${eventId}:submissions:full`),
			bindings.CACHE.delete(`user:${userId}:submissions:full`),
			bindings.CACHE.delete(`event:${eventId}:user:${userId}:submissions:full`),
			bindings.CACHE.delete(`event:${eventId}:submissions:full:desc:no-search:page:1:limit:100`),
			bindings.CACHE.delete(`user:${userId}:submissions:full:desc:no-search:page:1:limit:100`),
			bindings.CACHE.delete(
				`event:${eventId}:user:${userId}:submissions:full:desc:no-search:page:1:limit:100`
			),
			// check countries photographed badge based on metadata from original image
			(async () => {
				try {
					const metadata = ExifReader.load(image);

					// try IPTC first, may not be available
					let country = metadata['Country/Primary Location Name']?.value?.toString();
					if (!country) {
						// try and use EXIF GPS data
						const latitude = Number(metadata.GPSLatitude?.value?.toString() || '0');
						const longitude = Number(metadata.GPSLongitude?.value?.toString() || '0');

						// ignore if no GPS data found in EXIF
						if (!latitude || !longitude) return;
						country = extractCountry(await reverseGeocode(latitude, longitude, bindings));
					}

					if (country) {
						// add progress to badge tracker
						const country0 = country.toLowerCase().replace(/\s/g, '_');
						await addBadgeProgress(
							userId.toString(),
							'event_countries_photographed',
							country0,
							bindings.KV
						);
					}
				} catch (err) {
					console.error('Failed to read EXIF metadata for badge checking:', err);
					return;
				}
			})()
		])
	);

	return { id, timestamp, image: image0 }; // return unencrypted image to caller
}

export async function deleteEventImageSubmission(
	eventId: bigint,
	userId: bigint,
	submissionId: string,
	bindings: Bindings,
	ctx: ExecutionContext
) {
	const imagePath = `events/${eventId}/submissions/${userId}_${submissionId}.webp`;

	// delete from R2, remove mapping from KV, remove from indices (including event-user intersection), invalidate caches
	ctx.waitUntil(
		Promise.all([
			bindings.R2.delete(imagePath),
			bindings.KV.delete(`event:submission:${submissionId}`),
			removeSubmissionFromIndex(`event:${eventId}:submission_ids`, submissionId, bindings.KV),
			removeSubmissionFromIndex(`user:${userId}:submission_ids`, submissionId, bindings.KV),
			removeSubmissionFromIndex(
				`event:${eventId}:user:${userId}:submission_ids`,
				submissionId,
				bindings.KV
			),
			bindings.CACHE.delete(`event:${eventId}:submissions`),
			bindings.CACHE.delete(`user:${userId}:submissions`),
			bindings.CACHE.delete(`event:${eventId}:submissions:full`),
			bindings.CACHE.delete(`user:${userId}:submissions:full`),
			bindings.CACHE.delete(`event:${eventId}:user:${userId}:submissions:full`),
			bindings.CACHE.delete(`event:${eventId}:submissions:full:desc:no-search:page:1:limit:100`),
			bindings.CACHE.delete(`user:${userId}:submissions:full:desc:no-search:page:1:limit:100`),
			bindings.CACHE.delete(
				`event:${eventId}:user:${userId}:submissions:full:desc:no-search:page:1:limit:100`
			)
		])
	);
}

export async function deleteEventImageSubmissions(
	eventId: bigint | null,
	userId: bigint | null,
	bindings: Bindings,
	ctx: ExecutionContext
) {
	if (!eventId && !userId) {
		return;
	}

	// Fetch all relevant submission IDs based on provided filters
	let submissionIds: string[] = [];

	if (eventId && userId) {
		// intersection of event and specific user
		const [eventIds, userIds] = await Promise.all([
			bindings.KV.get<string[]>(`event:${eventId}:submission_ids`, 'json'),
			bindings.KV.get<string[]>(`user:${userId}:submission_ids`, 'json')
		]);

		if (!eventIds || !userIds) {
			return;
		}

		const eventIdsSet = new Set(eventIds);
		submissionIds = userIds.filter((id) => eventIdsSet.has(id));
	} else if (eventId) {
		// submissions under an event
		const ids = await bindings.KV.get<string[]>(`event:${eventId}:submission_ids`, 'json');
		submissionIds = ids || [];
	} else if (userId) {
		// submissions of a user
		const ids = await bindings.KV.get<string[]>(`user:${userId}:submission_ids`, 'json');
		submissionIds = ids || [];
	}

	if (submissionIds.length === 0) {
		return;
	}

	// delete all submissions in parallel with batching
	const promises = submissionIds.map(async (submissionId) => {
		const imagePath = `events/${eventId}/submissions/${userId}_${submissionId}.webp`;

		await Promise.all([
			bindings.R2.delete(imagePath),
			bindings.KV.delete(`event:submission:${submissionId}`),
			removeSubmissionFromIndex(`event:${eventId}:submission_ids`, submissionId, bindings.KV),
			removeSubmissionFromIndex(`user:${userId}:submission_ids`, submissionId, bindings.KV),
			removeSubmissionFromIndex(
				`event:${eventId}:user:${userId}:submission_ids`,
				submissionId,
				bindings.KV
			)
		]);
	});

	ctx.waitUntil(
		(async () => {
			await batchProcess(promises);
			console.log(
				`Deleted ${submissionIds.length} submissions for eventId=${eventId} userId=${userId}`
			);
		})()
	);
}

export async function getEventImage(
	submissionId: string,
	bindings: Bindings
): Promise<[Uint8Array | null, bigint | null, bigint | null, number | null]> {
	// [image data, eventId, userId, timestamp]
	const data = await bindings.KV.getWithMetadata<{
		eventId: string;
		userId: string;
		timestamp: number;
	}>(`event:submission:${submissionId}`);
	if (!data.value || !data.metadata) return [null, null, null, null];

	const obj = await bindings.R2.get(data.value);
	if (!obj) return [null, null, null, null];

	const buf = await obj.arrayBuffer();

	// Decrypt the encrypted image data
	const encryptedData = new Uint8Array(buf);
	const decryptedImage = await decryptImage(encryptedData, bindings.ENCRYPTION_KEY);

	const eventId = BigInt(data.metadata.eventId);
	const userId = BigInt(data.metadata.userId);
	const timestamp = data.metadata.timestamp;

	return [decryptedImage, eventId, userId, timestamp];
}

/**
 * Retrieve event image submissions with full image data as data URLs.
 * Supports filtering by eventId, userId, or both (intersection).
 * Uses reverse indices and caching for optimal performance.
 */

export async function getEventImageSubmissionsWithData(
	eventId: bigint | null,
	userId: bigint | null,
	bindings: Bindings,
	limit: number = 100,
	page: number = 1,
	sort: 'asc' | 'desc' | 'rand' = 'desc',
	search?: string
): Promise<
	{
		submission_id: string;
		event_id: string;
		user_id: string;
		timestamp: number;
		image: string;
		score?: ScoreResult;
		caption?: string;
		scored_at?: Date;
	}[]
> {
	if (!eventId && !userId) {
		return [];
	}

	// Build cache key based on query parameters
	const suffix = `${sort}:${search || 'no-search'}:page:${page}:limit:${limit}`;
	let cacheKey: string;
	if (eventId && userId) {
		cacheKey = `event:${eventId}:user:${userId}:submissions:full:${suffix}`;
	} else if (eventId) {
		cacheKey = `event:${eventId}:submissions:full:${suffix}`;
	} else {
		cacheKey = `user:${userId}:submissions:full:${suffix}`;
	}

	return await tryCache(
		cacheKey,
		bindings.CACHE,
		async () => {
			let submissionIds: string[] = [];

			if (eventId && userId) {
				// Both provided: find intersection for optimal performance
				const [eventIds, userIds] = await Promise.all([
					bindings.KV.get<string[]>(`event:${eventId}:submission_ids`, 'json'),
					bindings.KV.get<string[]>(`user:${userId}:submission_ids`, 'json')
				]);

				if (!eventIds || !userIds) {
					return [];
				}

				// Intersect the two arrays (submissions that belong to both event AND user)
				const eventIdsSet = new Set(eventIds);
				submissionIds = userIds.filter((id) => eventIdsSet.has(id));
			} else if (eventId) {
				// Only event provided
				const ids = await bindings.KV.get<string[]>(`event:${eventId}:submission_ids`, 'json');
				submissionIds = ids || [];
			} else if (userId) {
				// Only user provided
				const ids = await bindings.KV.get<string[]>(`user:${userId}:submission_ids`, 'json');
				submissionIds = ids || [];
			}

			if (submissionIds.length === 0) {
				return [];
			}

			// Fetch full image data and scores for all submissions in parallel
			const imagePromises = submissionIds.map(async (submissionId) => {
				const [image, eventIdResult, userIdResult, timestamp] = await getEventImage(
					submissionId,
					bindings
				);

				if (!image || !eventIdResult || !userIdResult || timestamp === null) {
					return null;
				}

				// Fetch score data in parallel with image processing
				const scoreKey = `event:image:score:${eventIdResult}:${submissionId}`;
				const scoreData = await bindings.KV.getWithMetadata<{
					caption: string;
					scored_at: number;
					user_id: string;
				}>(scoreKey);

				// Parse score data with error handling for corrupted data
				let score: ScoreResult | undefined;
				try {
					score = scoreData.value ? (JSON.parse(scoreData.value) as ScoreResult) : undefined;
				} catch (err) {
					console.error(`Failed to parse score data for ${submissionId}:`, err);
					score = undefined;
				}

				return {
					submission_id: submissionId,
					event_id: eventIdResult.toString(),
					user_id: userIdResult.toString(),
					timestamp,
					image: toDataURL(image, 'image/webp'),
					score,
					caption: scoreData.metadata?.caption,
					scored_at: scoreData.metadata?.scored_at
						? new Date(scoreData.metadata.scored_at)
						: undefined
				};
			});

			const results = await batchProcess(imagePromises);
			const filtered = results.filter((r) => r !== null) as {
				submission_id: string;
				event_id: string;
				user_id: string;
				timestamp: number;
				image: string;
				score?: ScoreResult;
				caption?: string;
				scored_at?: Date;
			}[];

			// deduplicate in case of race conditions in index writes
			const seen = new Set<string>();
			const deduplicated = filtered.filter((item) => {
				if (seen.has(item.submission_id)) return false;
				seen.add(item.submission_id);
				return true;
			});

			// search caption, user_id, event_id, and submission_id if search query provided
			const normalizedSearch = search ? normalizeId(search) : undefined;
			const searched = search
				? deduplicated.filter(
						(item) =>
							item.caption?.toLowerCase().includes(search.toLowerCase()) ||
							item.user_id === normalizedSearch ||
							item.event_id === normalizedSearch ||
							item.submission_id === normalizedSearch
					)
				: deduplicated;

			// sort by timestamp
			switch (sort) {
				case 'asc': // oldest first
					searched.sort((a, b) => a.timestamp - b.timestamp);
					break;
				case 'desc': // newest first
					searched.sort((a, b) => b.timestamp - a.timestamp);
					break;
				case 'rand':
					for (let i = searched.length - 1; i > 0; i--) {
						const j = Math.floor(Math.random() * (i + 1));
						[searched[i], searched[j]] = [searched[j], searched[i]];
					}
					break;
			}

			// Apply pagination
			const startIndex = (page - 1) * limit;
			const endIndex = startIndex + limit;
			return searched.slice(startIndex, endIndex);
		},
		60 * 60 * 24 * 30 // 30 days cache for better performance, invalidated on submission/deletion
	);
}
