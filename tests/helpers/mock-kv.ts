export type StoredKVValue = {
	value: string;
	metadata?: unknown;
	expiration?: number;
};

function toText(value: unknown): string {
	if (typeof value === 'string') return value;
	if (value instanceof Uint8Array) return new TextDecoder().decode(value);
	if (value instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(value));
	if (ArrayBuffer.isView(value)) {
		return new TextDecoder().decode(
			new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
		);
	}
	if (value === null || value === undefined) return '';
	return String(value);
}

export class MockKVNamespace {
	private readonly store = new Map<string, StoredKVValue>();

	async get<T = unknown>(key: string, type?: 'json'): Promise<T | null>;
	async get(key: string, type?: 'text'): Promise<string | null>;
	async get(key: string, type?: 'arrayBuffer'): Promise<ArrayBuffer | null>;
	async get(key: string, type?: 'stream'): Promise<ReadableStream | null>;
	async get<T = unknown>(
		key: string,
		type?: 'text' | 'json' | 'arrayBuffer' | 'stream'
	): Promise<T | string | null> {
		const entry = this.store.get(key);
		if (!entry) return null;

		if (type === 'json') {
			return JSON.parse(entry.value) as T;
		}

		if (type === 'arrayBuffer') {
			const bytes = new TextEncoder().encode(entry.value);
			return bytes.buffer as T;
		}

		if (type === 'stream') {
			const bytes = new TextEncoder().encode(entry.value);
			return new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(bytes);
					controller.close();
				}
			}) as T;
		}

		return entry.value;
	}

	async getWithMetadata<TValue = unknown, TMetadata = unknown>(
		key: string,
		type?: 'text' | 'json' | 'arrayBuffer' | 'stream'
	): Promise<{
		value: TValue | string | null;
		metadata: TMetadata | null;
	}> {
		const entry = this.store.get(key);
		if (!entry) {
			return { value: null, metadata: null };
		}

		let value: TValue | string;
		if (type === 'json') {
			value = JSON.parse(entry.value) as TValue;
		} else if (type === 'arrayBuffer') {
			value = new TextEncoder().encode(entry.value).buffer as TValue;
		} else if (type === 'stream') {
			const bytes = new TextEncoder().encode(entry.value);
			value = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(bytes);
					controller.close();
				}
			}) as TValue;
		} else {
			value = entry.value;
		}

		return {
			value,
			metadata: (entry.metadata ?? null) as TMetadata | null
		};
	}

	async put(
		key: string,
		value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
		options?: { expirationTtl?: number; metadata?: unknown }
	): Promise<void> {
		let text = '';
		if (value instanceof ReadableStream) {
			const reader = value.getReader();
			const chunks: Uint8Array[] = [];
			while (true) {
				const { done, value: chunk } = await reader.read();
				if (done) break;
				if (chunk) chunks.push(chunk);
			}
			const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
			const bytes = new Uint8Array(size);
			let offset = 0;
			for (const chunk of chunks) {
				bytes.set(chunk, offset);
				offset += chunk.length;
			}
			text = new TextDecoder().decode(bytes);
		} else {
			text = toText(value);
		}

		this.store.set(key, {
			value: text,
			metadata: options?.metadata,
			expiration: options?.expirationTtl ? Date.now() + options.expirationTtl * 1000 : undefined
		});
	}

	async delete(key: string): Promise<void> {
		this.store.delete(key);
	}

	async list<TMetadata = unknown>(options?: {
		prefix?: string;
		limit?: number;
		cursor?: string;
	}): Promise<{
		keys: Array<{ name: string; metadata?: TMetadata }>;
		list_complete: boolean;
		cursor?: string;
	}> {
		const prefix = options?.prefix ?? '';
		const limit = options?.limit ?? 1000;
		const cursorIndex = options?.cursor ? Number(options.cursor) : 0;

		const entries = [...this.store.entries()]
			.filter(([key]) => key.startsWith(prefix))
			.sort(([a], [b]) => a.localeCompare(b));

		const page = entries.slice(cursorIndex, cursorIndex + limit);
		const nextIndex = cursorIndex + page.length;
		const listComplete = nextIndex >= entries.length;

		return {
			keys: page.map(([name, value]) => ({
				name,
				metadata: value.metadata as TMetadata
			})),
			list_complete: listComplete,
			cursor: listComplete ? undefined : String(nextIndex)
		};
	}

	has(key: string): boolean {
		return this.store.has(key);
	}

	clear(): void {
		this.store.clear();
	}
}
