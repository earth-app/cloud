import { KVNamespace } from '@cloudflare/workers-types';
import Pako from 'pako';

export function capitalizeFully(str: string): string {
	return str;
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

export function fromDataURL(dataUrl: string): { mimeType: string; data: Uint8Array } | null {
	const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
	if (!match) return null;
	try {
		const binary = atob(match[2]);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		return { mimeType: match[1], data: bytes };
	} catch {
		return null;
	}
}

/**
 * Normalize a potentially zero-padded numeric ID.
 * Converts to BigInt and back to string to strip leading zeros.
 * Returns the original string if it's not a valid numeric ID.
 */
export function normalizeId(id: string): string {
	if (!/^\d+$/.test(id)) return id;
	try {
		return BigInt(id).toString();
	} catch {
		return id;
	}
}

export function isLegacyPaddedId(id: string): boolean {
	return /^0{5,}\d+$/.test(id);
}

export async function migrateLegacyKey(
	oldKey: string,
	newKey: string,
	kv: KVNamespace
): Promise<boolean> {
	const result = await kv.getWithMetadata(oldKey);
	if (!result.value) return false;

	const metadata = result.metadata || undefined;
	await kv.put(newKey, result.value, { metadata });

	await kv.delete(oldKey);
	return true;
}

export async function migrateAllLegacyKeys(kv: KVNamespace): Promise<number> {
	const prefixes = ['journey:', 'user:badge:', 'user:badge_tracker:', 'user:impact_points:'];
	let migratedCount = 0;

	for (const prefix of prefixes) {
		let page = await kv.list({ prefix, limit: 1000 });

		for (const key of page.keys) {
			const keyName = key.name;
			const parts = keyName.split(':');

			let needsMigration = false;
			const newParts = parts.map((part) => {
				if (isLegacyPaddedId(part)) {
					needsMigration = true;
					return normalizeId(part);
				}
				return part;
			});

			if (needsMigration) {
				const newKey = newParts.join(':');
				const migrated = await migrateLegacyKey(keyName, newKey, kv);
				if (migrated) {
					migratedCount++;
					console.log(`Migrated: ${keyName} -> ${newKey}`);
				}
			}
		}

		while (!page.list_complete && page.cursor) {
			page = await kv.list({ prefix, limit: 1000, cursor: page.cursor });

			for (const key of page.keys) {
				const keyName = key.name;
				const parts = keyName.split(':');

				let needsMigration = false;
				const newParts = parts.map((part) => {
					if (isLegacyPaddedId(part)) {
						needsMigration = true;
						return normalizeId(part);
					}
					return part;
				});

				if (needsMigration) {
					const newKey = newParts.join(':');
					const migrated = await migrateLegacyKey(keyName, newKey, kv);
					if (migrated) {
						migratedCount++;
						console.log(`Migrated: ${keyName} -> ${newKey}`);
					}
				}
			}
		}
	}

	return migratedCount;
}

export function chunkArray<T>(arr: T[], size: number): Array<T[]> {
	const result = [];
	for (let i = 0; i < arr.length; i += size) {
		result.push(arr.slice(i, i + size));
	}
	return result;
}

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

// batch promises at X concurrency to avoid memory issues, rate limits, or overwhelming downstream services
export async function batchProcess<T>(
	promises: Promise<T>[],
	batchSize: number = 600
): Promise<T[]> {
	const results: T[] = [];
	for (let i = 0; i < promises.length; i += batchSize) {
		const batch = promises.slice(i, i + batchSize);
		const batchResults = await Promise.all(batch);
		results.push(...batchResults);
	}
	return results;
}

export async function encrypt(data: Uint8Array, encryptionKey: string): Promise<Uint8Array> {
	const keyData = Uint8Array.from(atob(encryptionKey), (c) => c.charCodeAt(0));
	const key = await crypto.subtle.importKey('raw', keyData, { name: 'AES-GCM' }, false, [
		'encrypt'
	]);

	// Generate a random 12-byte IV
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data as BufferSource);

	// Prepend IV to ciphertext
	const result = new Uint8Array(iv.length + encrypted.byteLength);
	result.set(iv, 0);
	result.set(new Uint8Array(encrypted), iv.length);

	return result;
}

export async function decrypt(
	encryptedData: Uint8Array,
	encryptionKey: string
): Promise<Uint8Array> {
	try {
		const keyData = Uint8Array.from(atob(encryptionKey), (c) => c.charCodeAt(0));
		const key = await crypto.subtle.importKey('raw', keyData, { name: 'AES-GCM' }, false, [
			'decrypt'
		]);

		if (encryptedData.length < 13) {
			throw new Error('Encrypted data is too short to contain IV and ciphertext');
		}

		// Extract IV (first 12 bytes) and ciphertext
		const iv = encryptedData.slice(0, 12);
		const ciphertext = encryptedData.slice(12);
		const decrypted = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv },
			key,
			ciphertext as BufferSource
		);

		return new Uint8Array(decrypted);
	} catch (err) {
		console.error('Image decryption failed:', err);
		throw new Error(
			'Failed to decrypt image data - image may be corrupted or encryption key changed'
		);
	}
}

export async function deflate(data: Uint8Array): Promise<Uint8Array> {
	const compressed = Pako.deflate(data);
	return compressed;
}

export async function inflate(data: Uint8Array): Promise<Uint8Array> {
	const decompressed = Pako.inflate(data);
	return decompressed;
}

export function isInsideLocation(
	current: [number, number],
	target: [number, number],
	radius: number
): boolean {
	const [currentLat, currentLng] = current;
	const [targetLat, targetLng] = target;

	const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
	const earthRadius = 6371000; // meters

	const dLat = toRadians(targetLat - currentLat);
	const dLng = toRadians(targetLng - currentLng);
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(toRadians(currentLat)) * Math.cos(toRadians(targetLat)) * Math.sin(dLng / 2) ** 2;
	const distance = 2 * earthRadius * Math.asin(Math.sqrt(a));

	return distance <= radius;
}

export function detectAudioFormat(data: Uint8Array): 'mp3' | 'flac' | 'aac' | null {
	if (data.length < 4) return null;
	// ID3 tag header (mp3)
	if (data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33) return 'mp3';
	// MPEG sync word: top 3 bits of byte 1 set + Layer bits 2-1 = 01 (Layer 3 = mp3)
	if (data[0] === 0xff && (data[1] & 0xe0) === 0xe0 && (data[1] & 0x06) === 0x02) return 'mp3';
	// fLaC magic (flac)
	if (data[0] === 0x66 && data[1] === 0x4c && data[2] === 0x61 && data[3] === 0x43) return 'flac';
	// AAC ADTS sync: 0xFF + top 3 bits set + Layer bits != 01
	if (data[0] === 0xff && (data[1] & 0xe0) === 0xe0 && (data[1] & 0x06) !== 0x02) return 'aac';
	return null;
}
