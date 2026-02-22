import { KVNamespace } from '@cloudflare/workers-types';

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

export async function encryptImage(data: Uint8Array, encryptionKey: string): Promise<Uint8Array> {
	const keyData = Uint8Array.from(atob(encryptionKey), (c) => c.charCodeAt(0));
	const key = await crypto.subtle.importKey('raw', keyData, { name: 'AES-GCM' }, false, [
		'encrypt'
	]);

	// Generate a random 12-byte IV
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const encrypted = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv },
		key,
		data.buffer as ArrayBuffer
	);

	// Prepend IV to ciphertext
	const result = new Uint8Array(iv.length + encrypted.byteLength);
	result.set(iv, 0);
	result.set(new Uint8Array(encrypted), iv.length);

	return result;
}

export async function decryptImage(
	encryptedData: Uint8Array,
	encryptionKey: string
): Promise<Uint8Array> {
	try {
		const keyData = Uint8Array.from(atob(encryptionKey), (c) => c.charCodeAt(0));
		const key = await crypto.subtle.importKey('raw', keyData, { name: 'AES-GCM' }, false, [
			'decrypt'
		]);

		// Extract IV (first 12 bytes) and ciphertext
		const iv = encryptedData.slice(0, 12);
		const ciphertext = encryptedData.slice(12);
		const decrypted = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv },
			key,
			ciphertext.buffer as ArrayBuffer
		);

		return new Uint8Array(decrypted);
	} catch (err) {
		console.error('Image decryption failed:', err);
		throw new Error(
			'Failed to decrypt image data - image may be corrupted or encryption key changed'
		);
	}
}
