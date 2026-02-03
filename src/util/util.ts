import { ExecutionContext } from '@cloudflare/workers-types';
import { generateProfilePhoto, UserProfilePromptData } from './ai';
import { Bindings } from './types';

export function trimToByteLimit(str: string, byteLimit: number): string {
	const encoder = new TextEncoder();
	const chars = Array.from(str);
	const byteLens: number[] = chars.map((c) => encoder.encode(c).length);
	const cum: number[] = [];
	for (let i = 0; i < byteLens.length; i++) {
		cum[i] = byteLens[i] + (i > 0 ? cum[i - 1] : 0);
	}

	// Binary-search for highest index whose cum[idx] <= byteLimit
	let lo = 0;
	let hi = chars.length - 1;
	let cut = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >>> 1;
		if (cum[mid] <= byteLimit) {
			cut = mid;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}

	// If nothing fits, return empty; else join up to cut
	return cut >= 0 ? chars.slice(0, cut + 1).join('') : '';
}

export function toDataURL(image: Uint8Array | ArrayBuffer, type = 'image/png'): string {
	const bytes = image instanceof Uint8Array ? image : new Uint8Array(image);

	const chunkSize = 0x2000; // 8KB chunks to stay well under call stack/arg limits
	let binary = '';
	for (let i = 0; i < bytes.length; i += chunkSize) {
		const chunk = bytes.subarray(i, i + chunkSize);
		binary += String.fromCharCode.apply(null, Array.from(chunk));
	}

	return `data:${type};base64,` + btoa(binary);
}

export function chunkArray<T>(arr: T[], size: number): Array<T[]> {
	const result = [];
	for (let i = 0; i < arr.length; i += size) {
		result.push(arr.slice(i, i + size));
	}
	return result;
}

/**
 * Converts a number to its ordinal form (1st, 2nd, 3rd, etc.)
 * @param num - The number to convert
 * @returns The ordinal string (e.g., "1st", "2nd", "3rd", "4th")
 */
export function toOrdinal(num: number): string {
	const j = num % 10;
	const k = num % 100;

	if (j === 1 && k !== 11) {
		return num + 'st';
	}
	if (j === 2 && k !== 12) {
		return num + 'nd';
	}
	if (j === 3 && k !== 13) {
		return num + 'rd';
	}
	return num + 'th';
}

export function splitContent(content: string): string[] {
	if (!content || content.trim().length === 0) {
		return [];
	}

	// Helper function to ensure proper punctuation
	const ensurePunctuation = (sentence: string): string => {
		const trimmed = sentence.trim();
		if (!trimmed) return trimmed;

		const lastChar = trimmed[trimmed.length - 1];
		if (['.', '!', '?'].includes(lastChar)) {
			return trimmed;
		}

		const questionStarters = [
			'who',
			'what',
			'when',
			'where',
			'why',
			'how',
			'is',
			'are',
			'do',
			'does',
			'did',
			'can',
			'could',
			'would',
			'should',
			'will'
		];

		const firstWord = trimmed.toLowerCase().split(/\s+/)[0];
		if (questionStarters.includes(firstWord)) {
			return trimmed + '?';
		}

		// Otherwise add a period
		return trimmed + '.';
	};

	// Split into sentences using common sentence-ending patterns
	// More nuanced approach that avoids splitting on:
	// - Initials (e.g., "A. A. LastName", "J. Smith", "U.S.A.")
	// - Common abbreviations (e.g., "Mr.", "Mrs.", "Inc.", "etc.")
	// - Numbers with periods (e.g., "3.14", "v2.0")

	// First, protect common patterns that shouldn't be split
	const protectedContent = content
		// Protect single capital letter followed by period and space (initials in names)
		.replace(/\b([A-Z])\.\s+/g, '$1~INITIAL~ ')
		// Protect common titles and abbreviations
		.replace(
			/\b(Mr|Mrs|Ms|Dr|Prof|Sr|Jr|Ph|Esq|Rev|Hon|Capt|Lt|Col|Gen|Sgt|vs|viz|etc|Inc|Corp|Co|Ltd|LLC|Ave|St|Rd|Blvd|Dept|Vol|No|Fig|Ph\.D|M\.D|B\.A|M\.A|B\.S|M\.S|D\.D\.S|J\.D|Ed\.D|Psy\.D)\.\s+/gi,
			'$1~ABBREV~ '
		)
		// Protect acronyms (e.g., U.S.A., N.A.S.A.)
		.replace(/\b([A-Z])\.([A-Z])\.(?:[A-Z]\.)*\b/g, (match) => match.replace(/\./g, '~ACRONYM~'))
		// Protect decimal numbers
		.replace(/\b(\d+)\.(\d+)\b/g, '$1~DECIMAL~$2')
		// Protect common Latin abbreviations
		.replace(/\b(e\.g|i\.e|et al|cf|ca|viz)\.\s+/gi, '$1~LATIN~ ');

	const sentenceRegex = /[.!?]+(?=\s+[A-Z]|$)/g;
	const sentences = protectedContent
		.split(sentenceRegex)
		.map((s) => {
			// Restore protected patterns
			const restored = s
				.replace(/~INITIAL~/g, '.')
				.replace(/~ABBREV~/g, '.')
				.replace(/~ACRONYM~/g, '.')
				.replace(/~DECIMAL~/g, '.')
				.replace(/~LATIN~/g, '.');
			return ensurePunctuation(restored.trim());
		})
		.filter((s) => s.length > 0);

	if (sentences.length === 0) {
		return [content];
	}

	// Transition words that often indicate paragraph breaks
	const transitionWords = [
		'however',
		'therefore',
		'furthermore',
		'moreover',
		'nevertheless',
		'consequently',
		'additionally',
		'meanwhile',
		'in contrast',
		'on the other hand',
		'as a result',
		'in conclusion',
		'for example',
		'for instance',
		'in fact',
		'indeed',
		'similarly',
		'likewise',
		'conversely',
		'nonetheless'
	];

	// Topic shift indicators (words that might indicate a new topic)
	const topicShiftWords = [
		'but',
		'yet',
		'still',
		'although',
		'though',
		'while',
		'whereas',
		'despite',
		'instead',
		'rather',
		'alternatively'
	];

	const paragraphs: string[] = [];
	let currentParagraph: string[] = [];

	for (let i = 0; i < sentences.length; i++) {
		const sentence = sentences[i];
		if (!sentence) continue;

		const sentenceLower = sentence.toLowerCase().trim();

		// Check if this sentence starts with a transition word
		const startsWithTransition = transitionWords.some(
			(word) =>
				sentenceLower.startsWith(word.toLowerCase() + ' ') ||
				sentenceLower.startsWith(word.toLowerCase() + ',')
		);

		// Check if this sentence starts with a topic shift word
		const startsWithTopicShift = topicShiftWords.some(
			(word) =>
				sentenceLower.startsWith(word.toLowerCase() + ' ') ||
				sentenceLower.startsWith(word.toLowerCase() + ',')
		);

		// Determine if we should start a new paragraph
		let shouldBreak = false;

		// Rule 1: Strong transition words often indicate a new paragraph
		if (startsWithTransition && currentParagraph.length >= 2) {
			shouldBreak = true;
		}

		// Rule 2: Avoid paragraphs with more than 4 sentences
		if (currentParagraph.length >= 4) {
			shouldBreak = true;
		}

		// Rule 3: Topic shift words after 3+ sentences suggest a break
		if (startsWithTopicShift && currentParagraph.length >= 3) {
			shouldBreak = true;
		}

		// Rule 4: Very long sentences (>150 chars) after 2+ sentences might warrant a break
		if (sentence.length > 150 && currentParagraph.length >= 2) {
			shouldBreak = true;
		}

		// Rule 5: Short impactful sentences after a longer paragraph can be standalone
		if (sentence.length < 50 && currentParagraph.length >= 3 && i < sentences.length - 1) {
			// Add current sentence to current paragraph and then break
			currentParagraph.push(sentence);
			paragraphs.push(currentParagraph.join(' '));
			currentParagraph = [];
			continue;
		}

		// Apply the break if determined
		if (shouldBreak && currentParagraph.length > 0) {
			paragraphs.push(currentParagraph.join(' '));
			currentParagraph = [sentence];
		} else {
			currentParagraph.push(sentence);
		}
	}

	// Add any remaining sentences as the final paragraph
	if (currentParagraph.length > 0) {
		paragraphs.push(currentParagraph.join(' '));
	}

	// Ensure we don't have any empty paragraphs and all paragraphs end with proper punctuation
	return paragraphs
		.filter((p) => p.trim().length > 0)
		.map((p) => {
			const trimmed = p.trim();
			const lastChar = trimmed[trimmed.length - 1];
			// Ensure paragraph ends with proper punctuation
			if (!['.', '!', '?'].includes(lastChar)) {
				return trimmed + '.';
			}
			return trimmed;
		});
}

export async function getProfilePhoto(id: bigint, bindings: Bindings): Promise<Uint8Array> {
	if (id === 1n) {
		const resp = await bindings.ASSETS.fetch('https://assets.local/cloud.png');
		const fallback = await resp!.arrayBuffer();
		return new Uint8Array(fallback);
	}

	const profileImage = `users/${id}/profile.png`;

	const obj = await bindings.R2.get(profileImage);
	if (obj) {
		const buf = await obj.arrayBuffer();
		return new Uint8Array(buf);
	}

	const resp = await bindings.ASSETS.fetch('https://assets.local/earth-app.png');
	const fallback = await resp!.arrayBuffer();
	return new Uint8Array(fallback);
}

export type ImageSizes = 32 | 128 | 1024 | null;
export const validSizes = [32, 128, 1024, null];

/**
 * Converts a ReadableStream to a Uint8Array by reading all chunks
 * @param stream - The ReadableStream to convert
 * @returns A Uint8Array containing all the data from the stream
 */
export async function streamToUint8Array(stream: ReadableStream): Promise<Uint8Array> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let totalLength = 0;

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value) {
				chunks.push(value);
				totalLength += value.length;
			}
		}
	} finally {
		reader.releaseLock();
	}

	const result = new Uint8Array(totalLength);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.length;
	}

	return result;
}

// profile photos

export async function newProfilePhoto(
	data: UserProfilePromptData,
	id: bigint,
	bindings: Bindings,
	ctx: ExecutionContext
) {
	const profileImage = `users/${id}/profile.png`;
	const profile = await generateProfilePhoto(data, bindings.AI);

	// put original image and schedule variations to be created in background
	ctx.waitUntil(
		Promise.all([
			bindings.R2.put(profileImage, profile, {
				httpMetadata: { contentType: 'image/png' }
			}),
			createPhotoVariation(128, profile, id, bindings, ctx),
			createPhotoVariation(32, profile, id, bindings, ctx)
		])
	);

	return profile;
}

export async function getProfileVariation(
	id: bigint,
	size: ImageSizes,
	bindings: Bindings,
	ctx: ExecutionContext
) {
	if (id === 1n) {
		const resp = await bindings.ASSETS.fetch('https://assets.local/cloud.png');
		const fallback = await resp!.arrayBuffer();
		return new Uint8Array(fallback);
	}

	if (!size || size === 1024) return await getProfilePhoto(id, bindings); // original size requested
	if (!validSizes.includes(size)) return await getProfilePhoto(id, bindings); // fallback to original on invalid size

	const profileImage = `users/${id}/profile_${size}.png`;
	const obj = await bindings.R2.get(profileImage);

	if (obj) {
		const buf = await obj.arrayBuffer();
		return new Uint8Array(buf);
	} else {
		const profileImageOriginal = `users/${id}/profile.png`;
		const originalObj = await bindings.R2.get(profileImageOriginal);
		if (!originalObj) {
			const resp = await bindings.ASSETS.fetch('https://assets.local/earth-app.png');
			const fallback = await resp!.arrayBuffer();
			return new Uint8Array(fallback);
		}
		const buf = await originalObj.arrayBuffer();
		const profile = new Uint8Array(buf);

		return await createPhotoVariation(size, profile, id, bindings, ctx);
	}
}

async function createPhotoVariation(
	size: ImageSizes,
	profile: Uint8Array,
	id: bigint,
	bindings: Bindings,
	ctx: ExecutionContext
): Promise<Uint8Array> {
	if (!size) return await getProfilePhoto(id, bindings);

	// create stream from profile data
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(profile);
			controller.close();
		}
	});

	const profileImage = `users/${id}/profile_${size}.png`;
	const transformedStream = (
		await bindings.IMAGES.input(stream)
			.transform({ width: size, height: size })
			.output({ format: 'image/png' })
	).image();

	const transformedImage = await streamToUint8Array(transformedStream);

	ctx.waitUntil(
		bindings.R2.put(profileImage, transformedImage, {
			httpMetadata: { contentType: 'image/png' }
		})
	);

	return transformedImage;
}

// event thumbnails

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

// event image submissions

export async function submitEventImage(
	eventId: bigint,
	image: Uint8Array,
	bindings: Bindings,
	ctx: ExecutionContext
) {
	const id = crypto.randomUUID().replace(/-/g, '');
	const timestamp = Date.now();
	const imagePath = `events/${eventId}/submissions/${id}.webp`;

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

	ctx.waitUntil(
		bindings.R2.put(imagePath, image0, {
			httpMetadata: {
				contentType: 'image/webp'
			}
		})
	);

	return { id, timestamp, image: image0 };
}

export async function getEventImageSubmissions(
	eventId: bigint,
	bindings: Bindings
): Promise<Array<{ id: string; image: Uint8Array }>> {
	const prefix = `events/${eventId}/submissions/`;
	const list = await bindings.R2.list({ prefix });

	const submissions: Array<{ id: string; image: Uint8Array }> = [];
	for (const obj of list.objects) {
		const buf = await bindings.R2.get(obj.key)!.then((o) => o?.arrayBuffer());
		if (!buf) continue;

		const idMatch = obj.key.match(/submissions\/(.+)\.webp$/);
		const id = idMatch ? idMatch[1] : 'unknown';
		submissions.push({
			id,
			image: new Uint8Array(buf)
		});
	}

	return submissions;
}

export async function deleteEventImageSubmission(
	eventId: bigint,
	submissionId: string,
	bindings: Bindings,
	ctx: ExecutionContext
) {
	const imagePath = `events/${eventId}/submissions/${submissionId}.webp`;
	ctx.waitUntil(bindings.R2.delete(imagePath));
}
