import { describe, expect, it, vi } from 'vitest';
import {
	cache,
	checkCacheExists,
	clearCache,
	clearCachePrefix,
	getCache,
	tryCache
} from '../../src/util/cache';
import { env } from 'cloudflare:workers';

function key(name: string): string {
	return `test:cache:${name}:${crypto.randomUUID()}`;
}

describe('cache', () => {
	it('stores serializable values in kv', async () => {
		const k = key('store');
		await cache(k, { value: 42 }, env.KV, 60);

		const stored = await env.KV.get(k);
		expect(stored).toContain('"value":42');
		await env.KV.delete(k);
	});

	it('serializes Uint8Array payloads', async () => {
		const k = key('bytes');
		await cache(k, { bytes: new Uint8Array([1, 2, 3]) }, env.KV);

		const parsed = await getCache<{ bytes: Uint8Array }>(k, env.KV);
		expect(Array.from(parsed?.bytes || [])).toEqual([1, 2, 3]);
		await env.KV.delete(k);
	});

	it('ignores falsy values', async () => {
		const k = key('null');
		await cache(k, null, env.KV);

		expect(await env.KV.get(k)).toBeNull();
	});
});

describe('getCache', () => {
	it('returns null when key is missing', async () => {
		expect(await getCache(key('missing'), env.KV)).toBeNull();
	});

	it('returns null when stored data is invalid json', async () => {
		const k = key('bad-json');
		await env.KV.put(k, '{invalid');

		expect(await getCache(k, env.KV)).toBeNull();
		await env.KV.delete(k);
	});
});

describe('checkCacheExists', () => {
	it('checks metadata existence without reading value', async () => {
		const existingKey = key('exists');
		await env.KV.put(existingKey, 'yes');

		expect(await checkCacheExists(existingKey, env.KV)).toBe(true);
		expect(await checkCacheExists(key('missing'), env.KV)).toBe(false);
		await env.KV.delete(existingKey);
	});
});

describe('tryCache', () => {
	it('returns cached value on hit and skips fallback', async () => {
		const k = key('hit');
		await env.KV.put(k, JSON.stringify({ ok: true }));
		const fallback = vi.fn(async () => ({ ok: false }));

		const result = await tryCache(k, env.KV, fallback);
		expect(result).toEqual({ ok: true });
		expect(fallback).not.toHaveBeenCalled();
		await env.KV.delete(k);
	});

	it('calls fallback on miss and stores result', async () => {
		const k = key('miss');
		const fallback = vi.fn(async () => ({ computed: true }));

		const result = await tryCache(k, env.KV, fallback, 60);
		expect(result).toEqual({ computed: true });
		expect(fallback).toHaveBeenCalledTimes(1);

		await Promise.resolve();
		const cached = await getCache<{ computed: boolean }>(k, env.KV);
		expect(cached).toEqual({ computed: true });
		await env.KV.delete(k);
	});

	it('throws for empty cache id', async () => {
		await expect(tryCache('', env.KV, async () => 1)).rejects.toThrow('Cache ID cannot be empty');
	});
});

describe('clearCache', () => {
	it('deletes a key', async () => {
		const k = key('tmp');
		await env.KV.put(k, 'value');

		await clearCache(k, env.KV);
		expect(await env.KV.get(k)).toBeNull();
	});
});

describe('clearCachePrefix', () => {
	it('deletes all keys under prefix', async () => {
		const prefix = `test:cache:pref:${crypto.randomUUID()}:`;
		const a = `${prefix}a`;
		const b = `${prefix}b`;
		const c = `test:cache:other:${crypto.randomUUID()}`;
		await env.KV.put(a, '1');
		await env.KV.put(b, '2');
		await env.KV.put(c, '3');

		await clearCachePrefix(prefix, env.KV);

		expect(await env.KV.get(a)).toBeNull();
		expect(await env.KV.get(b)).toBeNull();
		expect(await env.KV.get(c)).toBe('3');
		await env.KV.delete(c);
	});
});
