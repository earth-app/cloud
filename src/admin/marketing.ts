import {
	createActivityData,
	createArticle,
	createArticleQuiz,
	createEvent,
	createPrompt,
	findArticle,
	findArticles,
	retrieveEvents
} from '../content/boat';
import type { Bindings, EventData } from '../util/types';

export type MarketingContentKind = 'activity' | 'event' | 'prompt' | 'article';

export const MARKETING_CONTENT_KINDS: MarketingContentKind[] = [
	'activity',
	'event',
	'prompt',
	'article'
];

export type MarketingGenerateResult = {
	kind: MarketingContentKind;
	source: 'ai';
	payload: unknown;
	// true when a clean dry-run wasn't possible and we synthesized a deterministic sample
	fallback?: boolean;
};

// seed words used when the admin gives no hint (activity/event dry-runs need a topic)
const DEFAULT_ACTIVITY_SEEDS = [
	'rock climbing',
	'community gardening',
	'trail running',
	'birdwatching',
	'beach cleanup',
	'urban sketching',
	'kayaking',
	'stargazing'
];

function pickRandom<T>(items: T[]): T {
	return items[Math.floor(Math.random() * items.length)]!;
}

// derive a mantle2-safe activity id + human phrase from an optional hint
export function seedActivity(hint?: string): { id: string; activity: string } {
	const raw = (hint && hint.trim()) || pickRandom(DEFAULT_ACTIVITY_SEEDS);
	const activity =
		raw
			.toLowerCase()
			.replace(/[^a-z0-9\s]/g, ' ')
			.replace(/\s+/g, ' ')
			.trim() || 'community gardening';
	const id = activity.replace(/\s+/g, '_').slice(0, 50);
	return { id, activity };
}

// deterministic event used only when the calendar bundle has no upcoming entry to dry-run
function synthEvent(hint?: string): EventData {
	const name = (hint && hint.trim()) || 'Community Earth Day Cleanup';
	const start = Date.now() + 3 * 24 * 60 * 60 * 1000;
	return {
		name,
		description:
			`Join us for ${name}. This is a preview event generated for marketing demos; ` +
			`it is not published and no one is signed up. Gather with neighbors to make a small, ` +
			`measurable difference for the planet.`,
		type: 'ONLINE',
		date: start,
		end_date: start + 2 * 60 * 60 * 1000,
		visibility: 'PUBLIC',
		activities: [],
		fields: {
			marketing_preview: 'true'
		}
	};
}

async function generateActivity(
	hint: string | undefined,
	env: Bindings
): Promise<MarketingGenerateResult> {
	const { id, activity } = seedActivity(hint);
	const payload = await createActivityData(id, activity, env.AI);
	return { kind: 'activity', source: 'ai', payload };
}

async function generatePrompt(env: Bindings): Promise<MarketingGenerateResult> {
	const prompt = await createPrompt(env.AI);
	return { kind: 'prompt', source: 'ai', payload: { prompt } };
}

async function generateArticle(
	hint: string | undefined,
	env: Bindings
): Promise<MarketingGenerateResult> {
	let ocean;
	let tags: string[] = [];

	if (hint && hint.trim().length >= 3) {
		const found = await findArticles(hint.trim(), env, 1);
		ocean = found[0];
		tags = (ocean?.keywords ?? []).slice(0, 8);
	}

	// no hint (or nothing matched) -> reuse the cron's top/bottom-ranked discovery
	if (!ocean) {
		const [oceans, discoveredTags] = await findArticle(env);
		ocean = oceans[0];
		tags = discoveredTags;
	}

	if (!ocean) {
		throw new Error('No source article could be found to generate from');
	}

	const article = await createArticle(ocean, env.AI, tags);
	// quiz is best-effort — never let a quiz miss fail the article preview
	const quiz = await createArticleQuiz(article, env.AI).catch(() => []);

	return {
		kind: 'article',
		source: 'ai',
		payload: { ...article, quiz }
	};
}

async function generateEvent(
	hint: string | undefined,
	env: Bindings
): Promise<MarketingGenerateResult> {
	try {
		const entries = await retrieveEvents();
		for (const entry of entries) {
			const event = await createEvent(entry.entry, entry.date, env);
			if (event) {
				return { kind: 'event', source: 'ai', payload: event };
			}
		}
	} catch (err) {
		console.warn('Marketing event dry-run via calendar failed; using synthesized fallback', {
			error: err instanceof Error ? err.message : String(err)
		});
	}

	// calendar had nothing dry-runnable — hand back a deterministic sample instead
	return { kind: 'event', source: 'ai', payload: synthEvent(hint), fallback: true };
}

export async function generateMarketingContent(
	kind: MarketingContentKind,
	hint: string | undefined,
	env: Bindings
): Promise<MarketingGenerateResult> {
	switch (kind) {
		case 'activity':
			return generateActivity(hint, env);
		case 'prompt':
			return generatePrompt(env);
		case 'article':
			return generateArticle(hint, env);
		case 'event':
			return generateEvent(hint, env);
	}
}
