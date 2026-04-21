import { logAnalyticsBatch } from '../content/analytics';
import { Article, Bindings, Prompt } from '../util/types';
import { addBadgeProgress } from './badges';

type TimerState = {
	startedAt: number;
	userId: string;
	field: string;
	metadata?: Record<string, any>;
	running: boolean;
};

type TimerRequestBody = {
	action?: string;
	userId?: string;
	field?: string;
	metadata?: Record<string, any>;
};

function normalizeText(value: unknown) {
	return typeof value === 'string' ? value.trim() : '';
}

function toRecord(value: unknown) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return undefined;
	}

	return value as Record<string, any>;
}

function pickContentId(fieldParameter: string, metadataId: unknown) {
	if (typeof metadataId === 'string' && metadataId.trim().length > 0) {
		return metadataId.trim();
	}

	return fieldParameter;
}

function articleAnalyticsMetadata(article?: Partial<Article>) {
	const metadata: Record<string, string> = {};
	if (typeof article?.author_id === 'string' && article.author_id) {
		metadata.author_id = article.author_id;
	}
	if (typeof article?.title === 'string' && article.title) {
		metadata.title = article.title;
	}

	return metadata;
}

function promptAnalyticsMetadata(prompt?: Partial<Prompt>) {
	const metadata: Record<string, string> = {};
	if (typeof prompt?.owner_id === 'string' && prompt.owner_id) {
		metadata.author_id = prompt.owner_id;
	}
	if (typeof prompt?.prompt === 'string' && prompt.prompt) {
		metadata.prompt = prompt.prompt;
	}

	return metadata;
}

export class UserTimer {
	state: DurableObjectState;
	env: Bindings;
	timer?: TimerState;

	constructor(state: DurableObjectState, env: Bindings) {
		this.state = state;
		this.env = env;
	}

	async fetch(req: Request) {
		let body: TimerRequestBody;

		try {
			body = await req.json<TimerRequestBody>();
		} catch {
			return new Response('Invalid JSON', { status: 400 });
		}

		const action = normalizeText(body.action);
		const userId = normalizeText(body.userId);
		const field = normalizeText(body.field);
		const metadata = toRecord(body.metadata);

		if (action === 'start') {
			if (!userId) {
				return new Response('User ID is required', { status: 400 });
			}

			if (!field) {
				return new Response('Field is required', { status: 400 });
			}

			const storedTimer = await this.state.storage.get<TimerState>('timer');
			if (storedTimer?.running) {
				this.timer = storedTimer;
				return new Response('Already running', { status: 409 });
			}

			const timer: TimerState = {
				startedAt: Date.now(),
				userId,
				field,
				metadata,
				running: true
			};
			this.timer = timer;

			await this.state.storage.put('timer', timer);
			return new Response(null, { status: 204 });
		}

		if (action === 'stop') {
			const timer = await this.state.storage.get<TimerState>('timer');
			if (!timer?.running) {
				return new Response('Not running', { status: 409 });
			}

			const durationMs = Math.max(0, Date.now() - timer.startedAt);
			await this.state.storage.delete('timer');
			this.timer = undefined;

			await applyField(timer.field, timer.userId, durationMs, timer.metadata || {}, this.env);

			return Response.json({ durationMs });
		}

		return new Response('Invalid action', { status: 400 });
	}
}

async function applyField(
	field: string,
	userId: string,
	durationMs: number,
	metadata: Record<string, any>,
	bindings: Bindings
) {
	const duration = Math.max(0, durationMs / 1000); // convert to seconds
	const [fieldName, rawFieldParameter] = field.split(':', 2);
	const fieldParameter = normalizeText(rawFieldParameter);

	switch (fieldName) {
		case 'articles_read_time': {
			const article = toRecord(metadata.article) as Partial<Article> | undefined;
			const contentId = pickContentId(fieldParameter, article?.id);
			const analyticsMetadata = articleAnalyticsMetadata(article);

			// mark as read if >1 minute
			if (duration > 60) {
				if (fieldParameter) {
					await addBadgeProgress(userId, 'articles_read', fieldParameter, bindings.KV);
				}
			}

			// add to articles_read_time
			await addBadgeProgress(userId, 'articles_read_time', duration, bindings.KV);

			if (contentId) {
				const entries: {
					category: string;
					value: number;
					metadata: Record<string, string>;
					includeTimingStats?: boolean;
				}[] = [
					{
						category: 'articles_clicked',
						value: 1,
						metadata: analyticsMetadata
					}
				];

				if (duration > 60) {
					entries.unshift({
						category: 'article_read_time',
						value: duration,
						metadata: analyticsMetadata,
						includeTimingStats: true
					});
				}

				await logAnalyticsBatch(contentId, userId, entries, bindings);
			}
			break;
		}
		case 'prompts_read_time': {
			const prompt = toRecord(metadata.prompt) as Partial<Prompt> | undefined;
			const contentId = pickContentId(fieldParameter, prompt?.id);
			const analyticsMetadata = promptAnalyticsMetadata(prompt);

			// mark as read if >30 seconds
			if (duration > 30) {
				if (fieldParameter) {
					await addBadgeProgress(userId, 'prompts_read', fieldParameter, bindings.KV);
				}
			}

			// add to prompts_read_time
			await addBadgeProgress(userId, 'prompts_read_time', duration, bindings.KV);

			if (contentId) {
				const entries: {
					category: string;
					value: number;
					metadata: Record<string, string>;
					includeTimingStats?: boolean;
				}[] = [
					{
						category: 'prompts_clicked',
						value: 1,
						metadata: analyticsMetadata
					}
				];

				if (duration > 30) {
					entries.unshift({
						category: 'prompt_read_time',
						value: duration,
						metadata: analyticsMetadata,
						includeTimingStats: true
					});
				}

				await logAnalyticsBatch(contentId, userId, entries, bindings);
			}
			break;
		}
	}
}
