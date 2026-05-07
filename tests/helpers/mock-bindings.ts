import { vi } from 'vitest';
import { Bindings, ExecutionCtxLike } from '../../src/util/types';
import { MockKVNamespace } from './mock-kv';

export class MockR2Bucket {
	private readonly store = new Map<string, Uint8Array>();

	async put(key: string, value: unknown): Promise<void> {
		if (value instanceof Uint8Array) {
			this.store.set(key, value);
			return;
		}
		if (value instanceof ArrayBuffer) {
			this.store.set(key, new Uint8Array(value));
			return;
		}
		if (typeof value === 'string') {
			this.store.set(key, new TextEncoder().encode(value));
			return;
		}
		this.store.set(key, new Uint8Array());
	}

	async get(key: string): Promise<{ arrayBuffer: () => Promise<ArrayBuffer> } | null> {
		const value = this.store.get(key);
		if (!value) return null;
		return {
			arrayBuffer: async () => new Uint8Array(value).buffer
		};
	}

	async delete(key: string): Promise<void> {
		this.store.delete(key);
	}

	async list(options?: {
		prefix?: string;
		limit?: number;
		cursor?: string;
	}): Promise<{ objects: Array<{ key: string }>; truncated: boolean; cursor?: string }> {
		const prefix = options?.prefix ?? '';
		const limit = options?.limit ?? 1000;
		const cursorIndex = options?.cursor ? Number(options.cursor) : 0;

		const keys = [...this.store.keys()].filter((key) => key.startsWith(prefix)).sort();
		const page = keys.slice(cursorIndex, cursorIndex + limit);
		const nextIndex = cursorIndex + page.length;
		const truncated = nextIndex < keys.length;

		return {
			objects: page.map((key) => ({ key })),
			truncated,
			cursor: truncated ? String(nextIndex) : undefined
		};
	}

	has(key: string): boolean {
		return this.store.has(key);
	}
}

export function createMockExecutionCtx(): ExecutionCtxLike {
	return {
		waitUntil: vi.fn((promise: Promise<unknown>) => {
			void promise;
		})
	};
}

function createMockImagesBinding() {
	return {
		input: (stream: ReadableStream) => ({
			transform: () => ({
				output: () => ({
					image: () => stream
				})
			})
		})
	};
}

function createMockDurableObjectNamespace() {
	const stubs = new Map<string, { fetch: ReturnType<typeof vi.fn> }>();

	return {
		__stubs: stubs,
		idFromName: (name: string) => name,
		get: (id: string) => {
			const stub = {
				fetch: vi.fn(async () => new Response('ok'))
			};
			stubs.set(String(id), stub);
			return stub;
		}
	};
}

export function createMockBindings(overrides: Partial<Bindings> = {}): Bindings {
	const kv = new MockKVNamespace();
	const cache = new MockKVNamespace();
	const r2 = new MockR2Bucket();

	const base: Bindings = {
		R2: r2 as unknown as R2Bucket,
		AI: {
			run: vi.fn(async () => ({}))
		} as unknown as Ai,
		KV: kv as unknown as KVNamespace,
		CACHE: cache as unknown as KVNamespace,
		ASSETS: {
			fetch: vi.fn(async (url: string) => {
				const fallback = url.includes('cloud.png') ? 'cloud' : 'earth';
				return new Response(new TextEncoder().encode(fallback), {
					headers: { 'Content-Type': 'image/png' }
				});
			})
		} as unknown as Fetcher,
		IMAGES: createMockImagesBinding() as unknown as ImagesBinding,
		NOTIFIER: createMockDurableObjectNamespace() as unknown as DurableObjectNamespace,
		TIMER: createMockDurableObjectNamespace() as unknown as DurableObjectNamespace,
		ADMIN_API_KEY: 'test-admin-key',
		NCBI_API_KEY: 'test-ncbi-key',
		MANTLE_URL: 'https://api.test.earth-app.com',
		MAPS_API_KEY: 'test-maps-key',
		ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
	};

	return {
		...base,
		...overrides
	};
}
