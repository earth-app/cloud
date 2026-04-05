import { describe, expect, it } from 'vitest';
import {
	batchProcess,
	capitalizeFully,
	chunkArray,
	decrypt,
	deflate,
	detectAudioFormat,
	encrypt,
	fromDataURL,
	inflate,
	isInsideLocation,
	isLegacyPaddedId,
	migrateAllLegacyKeys,
	migrateLegacyKey,
	normalizeId,
	streamToUint8Array,
	toDataURL
} from '../../src/util/util';
import { env } from 'cloudflare:workers';

function key(name: string): string {
	return `test:util:${name}:${crypto.randomUUID()}`;
}

describe('capitalizeFully', () => {
	it('capitalizes mixed-case words', () => {
		expect(capitalizeFully('hello')).toBe('Hello');
		expect(capitalizeFully('WORLD')).toBe('World');
		expect(capitalizeFully('tEsT case')).toBe('Test Case');
	});
});

describe('toDataURL', () => {
	it('encodes bytes to base64 data url', () => {
		const bytes = new Uint8Array([72, 105]);
		const dataUrl = toDataURL(bytes, 'text/plain');

		expect(dataUrl.startsWith('data:text/plain;base64,')).toBe(true);
	});
});

describe('fromDataURL', () => {
	it('decodes valid base64 data url', () => {
		const source = new Uint8Array([1, 2, 3, 4]);
		const dataUrl = toDataURL(source, 'application/octet-stream');
		const parsed = fromDataURL(dataUrl);

		expect(parsed).not.toBeNull();
		expect(parsed?.mimeType).toBe('application/octet-stream');
		expect(Array.from(parsed?.data || [])).toEqual([1, 2, 3, 4]);
	});

	it('returns null for invalid input', () => {
		expect(fromDataURL('invalid')).toBeNull();
	});
});

describe('normalizeId', () => {
	it('removes leading zeros from numeric ids', () => {
		expect(normalizeId('0000123')).toBe('123');
		expect(normalizeId('0000')).toBe('0');
	});

	it('returns input unchanged for non-numeric ids', () => {
		expect(normalizeId('abc123')).toBe('abc123');
	});
});

describe('isLegacyPaddedId', () => {
	it('detects ids with 5 or more leading zeros', () => {
		expect(isLegacyPaddedId('00000123')).toBe(true);
		expect(isLegacyPaddedId('000123')).toBe(false);
	});
});

describe('migrateLegacyKey', () => {
	it('copies value+metadata and deletes old key', async () => {
		const oldKey = key('old');
		const newKey = key('new');
		await env.KV.put(oldKey, JSON.stringify({ ok: true }), {
			metadata: { version: 1 }
		});

		const migrated = await migrateLegacyKey(oldKey, newKey, env.KV);

		expect(migrated).toBe(true);
		expect(await env.KV.get(oldKey)).toBeNull();
		expect(await env.KV.get(newKey)).not.toBeNull();

		const newValue = await env.KV.getWithMetadata<{ version: number }>(newKey);
		expect(newValue.metadata?.version).toBe(1);
		await env.KV.delete(newKey);
	});

	it('returns false when source key is missing', async () => {
		const newKey = key('new-missing');
		const migrated = await migrateLegacyKey(key('missing'), newKey, env.KV);

		expect(migrated).toBe(false);
		expect(await env.KV.get(newKey)).toBeNull();
	});
});

describe('migrateAllLegacyKeys', () => {
	it('migrates legacy padded ids across supported prefixes', async () => {
		const randomNum = () => Math.floor(Math.random() * 90000 + 10000).toString();
		const legacyJourneyId = `00000${randomNum()}`;
		const legacyBadgeId = `00000${randomNum()}`;
		const legacyPointsId = `00000${randomNum()}`;
		const oldJourney = `journey:article:${legacyJourneyId}`;
		const oldBadge = `user:badge:${legacyBadgeId}:test_badge`;
		const oldPoints = `user:impact_points:${legacyPointsId}`;
		const oldPrompt = `journey:prompt:${randomNum()}`;

		await env.KV.put(oldJourney, '4', { metadata: { streak: 4, lastWrite: 1 } });
		await env.KV.put(oldBadge, JSON.stringify({ progress: 1 }));
		await env.KV.put(oldPoints, JSON.stringify([{ difference: 1 }]), {
			metadata: { total: 1 }
		});
		await env.KV.put(oldPrompt, '2', { metadata: { streak: 2, lastWrite: 2 } });

		const count = await migrateAllLegacyKeys(env.KV);

		expect(count).toBeGreaterThanOrEqual(3);

		const newJourney = oldJourney
			.split(':')
			.map((p) => (/^0{5,}\d+$/.test(p) ? BigInt(p).toString() : p))
			.join(':');
		const newBadge = oldBadge
			.split(':')
			.map((p) => (/^0{5,}\d+$/.test(p) ? BigInt(p).toString() : p))
			.join(':');
		const newPoints = oldPoints
			.split(':')
			.map((p) => (/^0{5,}\d+$/.test(p) ? BigInt(p).toString() : p))
			.join(':');

		expect(await env.KV.get(newJourney)).toBe('4');
		expect(await env.KV.get(newBadge)).not.toBeNull();
		expect(await env.KV.get(newPoints)).not.toBeNull();

		await Promise.all([
			env.KV.delete(oldPrompt),
			env.KV.delete(newJourney),
			env.KV.delete(newBadge),
			env.KV.delete(newPoints)
		]);
	});
});

describe('chunkArray', () => {
	it('splits arrays into fixed-size chunks', () => {
		expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
		expect(chunkArray([], 3)).toEqual([]);
	});
});

describe('streamToUint8Array', () => {
	it('reads all chunks from stream into one array', async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([1, 2]));
				controller.enqueue(new Uint8Array([3, 4, 5]));
				controller.close();
			}
		});

		const result = await streamToUint8Array(stream);
		expect(Array.from(result)).toEqual([1, 2, 3, 4, 5]);
	});
});

describe('batchProcess', () => {
	it('resolves all promises in batches and preserves order', async () => {
		const promises = [
			Promise.resolve(1),
			Promise.resolve(2),
			Promise.resolve(3),
			Promise.resolve(4)
		];

		const result = await batchProcess(promises, 2);
		expect(result).toEqual([1, 2, 3, 4]);
	});
});

describe('encrypt', () => {
	it('encrypts payload by prepending iv bytes', async () => {
		const data = new TextEncoder().encode('hello world');
		const key = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
		const encrypted = await encrypt(data, key);

		expect(encrypted.byteLength).toBeGreaterThan(data.byteLength);
		expect(encrypted.slice(0, 12)).toHaveLength(12);
	});
});

describe('decrypt', () => {
	it('decrypts encrypted payload with matching key', async () => {
		const data = new TextEncoder().encode('earth app');
		const key = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
		const encrypted = await encrypt(data, key);
		const decrypted = await decrypt(encrypted, key);

		expect(new TextDecoder().decode(decrypted)).toBe('earth app');
	});

	it('throws on malformed encrypted payload', async () => {
		await expect(
			decrypt(new Uint8Array([1, 2, 3]), 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=')
		).rejects.toThrow('Failed to decrypt image data');
	});
});

describe('deflate', () => {
	it('compresses byte payloads', async () => {
		const input = new TextEncoder().encode('compress-me-compress-me-compress-me');
		const compressed = await deflate(input);

		expect(compressed.byteLength).toBeGreaterThan(0);
	});
});

describe('inflate', () => {
	it('round-trips compressed data', async () => {
		const input = new TextEncoder().encode('roundtrip data');
		const compressed = await deflate(input);
		const restored = await inflate(compressed);

		expect(new TextDecoder().decode(restored)).toBe('roundtrip data');
	});
});

describe('isInsideLocation', () => {
	it('returns true when target is within radius', () => {
		const inside = isInsideLocation([40.7128, -74.006], [40.713, -74.0062], 100);
		expect(inside).toBe(true);
	});

	it('returns false when target is outside radius', () => {
		const outside = isInsideLocation([40.7128, -74.006], [40.75, -74.006], 1000);
		expect(outside).toBe(false);
	});
});

describe('detectAudioFormat', () => {
	it('detects mp3 from ID3 header', () => {
		expect(detectAudioFormat(new Uint8Array([0x49, 0x44, 0x33, 0x00]))).toBe('mp3');
	});

	it('detects flac from magic bytes', () => {
		expect(detectAudioFormat(new Uint8Array([0x66, 0x4c, 0x61, 0x43]))).toBe('flac');
	});

	it('detects aac from sync header', () => {
		expect(detectAudioFormat(new Uint8Array([0xff, 0xf1, 0x00, 0x00]))).toBe('aac');
	});

	it('returns null for unsupported/short data', () => {
		expect(detectAudioFormat(new Uint8Array([1, 2, 3]))).toBeNull();
	});
});
