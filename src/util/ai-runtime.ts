import { stripMarkdownCodeFence } from './lang';

// thrown when the whole retry budget is spent on timeouts
export class AITimeoutError extends Error {
	constructor(
		public readonly kind: string,
		public readonly ms: number
	) {
		super(`AI call "${kind}" timed out after ${ms}ms`);
		this.name = 'AITimeoutError';
	}
}

// thrown when the model erred / returned an unusable result on every attempt
export class AIUnavailableError extends Error {
	constructor(
		public readonly kind: string,
		public readonly attempts: number,
		options?: { cause?: unknown }
	) {
		super(
			`AI call "${kind}" failed after ${attempts} attempt${attempts === 1 ? '' : 's'}`,
			options
		);
		this.name = 'AIUnavailableError';
	}
}

export type RunAIOptions = {
	attempts?: number; // total tries incl. the first (default 3)
	perAttemptTimeoutMs?: number; // hard cap on a single attempt (default 4000)
	totalTimeoutMs?: number; // hard cap across all attempts (default 8000)
	backoffMs?: number; // base linear backoff between attempts (default 150)
	// treat a non-throwing but unusable result (e.g. empty/garbage) as retryable
	shouldRetryResult?: (value: unknown) => boolean;
};

const DEFAULTS = {
	attempts: 3,
	perAttemptTimeoutMs: 4000,
	// keep total under mantle2's 10s curl budget so a cold start can't stack past it
	totalTimeoutMs: 8000,
	backoffMs: 150
};

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// env.AI.run / IMAGES transform do not accept an AbortSignal, so a timed-out call may
// keep running on cloudflare's side; we just stop waiting on it and move on
function withTimeout<T>(kind: string, ms: number, fn: () => Promise<T>): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			reject(new AITimeoutError(kind, ms));
		}, ms);
		fn().then(
			(value) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(value);
			},
			(err) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				reject(err);
			}
		);
	});
}

// run an ai call with bounded retry + timeout; throws AITimeoutError or AIUnavailableError
// once the budget is exhausted so callers can degrade to a clear, non-hanging response
export async function runAI<T>(
	kind: string,
	fn: () => Promise<T>,
	opts: RunAIOptions = {}
): Promise<T> {
	const attempts = Math.max(1, opts.attempts ?? DEFAULTS.attempts);
	const perAttempt = opts.perAttemptTimeoutMs ?? DEFAULTS.perAttemptTimeoutMs;
	const total = opts.totalTimeoutMs ?? DEFAULTS.totalTimeoutMs;
	const backoff = opts.backoffMs ?? DEFAULTS.backoffMs;
	const deadline = Date.now() + total;

	let lastErr: unknown;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) break;

		const attemptMs = Math.min(perAttempt, remaining);
		try {
			const value = await withTimeout<T>(kind, attemptMs, fn);
			if (opts.shouldRetryResult?.(value)) {
				lastErr = new Error(`AI call "${kind}" returned an unusable result`);
			} else {
				return value;
			}
		} catch (err) {
			lastErr = err;
		}

		// linear backoff, but never past the deadline
		if (attempt < attempts) {
			const wait = Math.min(backoff * attempt, Math.max(0, deadline - Date.now()));
			if (wait > 0) await delay(wait);
		}
	}

	if (lastErr instanceof AITimeoutError) throw lastErr;
	throw new AIUnavailableError(kind, attempts, { cause: lastErr });
}

// pull the text payload out of any workers-ai shape: top-level `.response`, the
// openai chat-completions `choices[0].message.content`, gpt-oss `output[].content[].text`,
// nested `.result.response`, plus whisper `.text` / llava `.description`
export function extractAIText(result: unknown): string {
	if (result == null) return '';
	if (typeof result === 'string') return result;
	if (typeof result !== 'object') return '';

	const r = result as Record<string, any>;

	if (typeof r.response === 'string') return r.response;
	if (typeof r.result?.response === 'string') return r.result.response;

	const choice = r.choices?.[0]?.message?.content;
	if (typeof choice === 'string') return choice;

	const output = r.output;
	if (Array.isArray(output)) {
		for (const item of output) {
			const parts = item?.content;
			if (Array.isArray(parts)) {
				for (const part of parts) {
					if (typeof part?.text === 'string') return part.text;
				}
			}
		}
	}

	if (typeof r.text === 'string') return r.text; // whisper
	if (typeof r.description === 'string') return r.description; // llava caption

	return '';
}

// tolerant json parse for model output: accepts an already-parsed object, a raw string,
// or any workers-ai wrapper; strips markdown fences and recovers an embedded object/array;
// returns null on empty/garbage rather than throwing
export function parseAIJson<T = unknown>(raw: unknown): T | null {
	// a plain object that is not a known ai wrapper is treated as already parsed
	if (raw && typeof raw === 'object' && extractAIText(raw) === '' && !Array.isArray(raw)) {
		return raw as T;
	}
	if (Array.isArray(raw)) return raw as T;

	const text = extractAIText(raw);
	const cleaned = stripMarkdownCodeFence(text).trim();
	if (!cleaned) return null;

	try {
		return JSON.parse(cleaned) as T;
	} catch {
		// fall through to substring recovery
	}

	const objStart = cleaned.indexOf('{');
	const objEnd = cleaned.lastIndexOf('}');
	if (objStart >= 0 && objEnd > objStart) {
		try {
			return JSON.parse(cleaned.slice(objStart, objEnd + 1)) as T;
		} catch {
			// fall through
		}
	}

	const arrStart = cleaned.indexOf('[');
	const arrEnd = cleaned.lastIndexOf(']');
	if (arrStart >= 0 && arrEnd > arrStart) {
		try {
			return JSON.parse(cleaned.slice(arrStart, arrEnd + 1)) as T;
		} catch {
			// fall through
		}
	}

	return null;
}
