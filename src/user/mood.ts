import { Bindings } from '../util/types';

// fixed emoji set; vote bodies that don't match are rejected so the bucket can't drift
export const EMOJIS = ['😍', '😊', '🤔', '😐', '😟', '😤'] as const;

export type MoodEmoji = (typeof EMOJIS)[number];

export type MoodCounts = Record<MoodEmoji, number>;

export type MoodSnapshot = {
	counts: MoodCounts;
	total: number;
	updated_at: number;
};

const TTL_SECONDS = 60 * 60 * 24 * 30; // 30 day sliding window, more than enough for daily aggregates

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TOPIC_RE = /^[a-zA-Z0-9-]{1,64}$/;

export function isValidEmoji(value: unknown): value is MoodEmoji {
	return typeof value === 'string' && (EMOJIS as readonly string[]).includes(value);
}

export function sanitizeTopic(input: string | undefined | null): string | null {
	if (!input) return null;
	const trimmed = input.trim().toLowerCase();
	if (!TOPIC_RE.test(trimmed)) return null;
	return trimmed;
}

export function sanitizeDate(input: string | undefined | null): string | null {
	if (!input) return null;
	const trimmed = input.trim();
	if (!DATE_RE.test(trimmed)) return null;
	// also validate the date is parseable so a string like 2026-13-40 doesn't slip through
	const parsed = new Date(`${trimmed}T00:00:00Z`);
	if (Number.isNaN(parsed.getTime())) return null;
	return trimmed;
}

function key(topic: string, date: string): string {
	return `mood:${topic}:${date}`;
}

function emptyCounts(): MoodCounts {
	return EMOJIS.reduce((acc, e) => {
		acc[e] = 0;
		return acc;
	}, {} as MoodCounts);
}

function normalize(raw: unknown): MoodCounts {
	const counts = emptyCounts();
	if (!raw || typeof raw !== 'object') return counts;
	for (const e of EMOJIS) {
		const v = (raw as Record<string, unknown>)[e];
		counts[e] = typeof v === 'number' && v >= 0 && Number.isFinite(v) ? Math.floor(v) : 0;
	}
	return counts;
}

export async function getMoodSnapshot(
	env: Bindings,
	topic: string,
	date: string
): Promise<MoodSnapshot | null> {
	const raw = await env.KV.get(key(topic, date));
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw);
		const counts = normalize(parsed?.counts);
		const total = (Object.values(counts) as number[]).reduce((a, b) => a + b, 0);
		const updated_at = typeof parsed?.updated_at === 'number' ? parsed.updated_at : Date.now();
		return { counts, total, updated_at };
	} catch {
		return null;
	}
}

// kv is eventually consistent — that's fine for anonymous aggregates. last-writer-wins
// can drop one or two votes under heavy concurrency; we accept that tradeoff for simplicity
export async function recordMood(
	env: Bindings,
	topic: string,
	date: string,
	emoji: MoodEmoji
): Promise<MoodSnapshot> {
	const existing = await getMoodSnapshot(env, topic, date);
	const counts = existing ? { ...existing.counts } : emptyCounts();
	counts[emoji] = (counts[emoji] ?? 0) + 1;
	const total = (Object.values(counts) as number[]).reduce((a, b) => a + b, 0);
	const snapshot: MoodSnapshot = {
		counts,
		total,
		updated_at: Date.now()
	};
	await env.KV.put(
		key(topic, date),
		JSON.stringify({ counts: snapshot.counts, updated_at: snapshot.updated_at }),
		{ expirationTtl: TTL_SECONDS }
	);
	return snapshot;
}
