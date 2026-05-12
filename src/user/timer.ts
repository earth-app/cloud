import { logAnalyticsBatch } from '../content/analytics';
import { Activity, Article, Bindings, Prompt } from '../util/types';
import { normalizeId } from '../util/util';
import { addBadgeProgress, TrackerEntry } from './badges';
import { checkStepDelay, getCurrentQuestProgress, updateQuestProgress } from './quests/tracking';

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

async function maybeAdvanceReadTimeQuestStep(
	userId: string,
	tracker: 'articles_read_time' | 'activity_read_time',
	bindings: Bindings
) {
	try {
		const questProgress = await getCurrentQuestProgress(userId, bindings);
		if (!questProgress.quest || questProgress.completed) {
			return;
		}

		const readTimeSeconds = await getReadTime(userId, tracker, bindings.KV);

		const currentStepIndex = questProgress.currentStepIndex;
		const currentStep = questProgress.currentStep;
		if (!currentStep) {
			return;
		}

		const stepType = tracker === 'articles_read_time' ? 'article_read_time' : 'activity_read_time';
		const currentProgress = questProgress.progress[currentStepIndex];

		let candidateAltIndex: number | undefined;
		let candidateThreshold: number | undefined;

		if (Array.isArray(currentStep)) {
			const completedAltIndices = new Set(
				Array.isArray(currentProgress) ? currentProgress.map((entry) => entry.altIndex ?? 0) : []
			);

			for (let altIndex = 0; altIndex < currentStep.length; altIndex++) {
				const step = currentStep[altIndex];
				if (step.type !== stepType) {
					continue;
				}

				if (completedAltIndices.has(altIndex)) {
					continue;
				}

				const [, requiredSeconds] = step.parameters;
				if (typeof requiredSeconds !== 'number' || readTimeSeconds < requiredSeconds) {
					continue;
				}

				candidateAltIndex = altIndex;
				candidateThreshold = requiredSeconds;
				break;
			}
		} else {
			if (currentStep.type !== stepType) {
				return;
			}

			if (currentProgress) {
				return;
			}

			const [, requiredSeconds] = currentStep.parameters;
			if (typeof requiredSeconds !== 'number' || readTimeSeconds < requiredSeconds) {
				return;
			}

			candidateThreshold = requiredSeconds;
		}

		if (candidateThreshold == null) {
			return;
		}

		const delayStatus = await checkStepDelay(userId, currentStepIndex, candidateAltIndex, bindings);
		if (!delayStatus.available) {
			return;
		}

		const waitUntilPromises: Promise<unknown>[] = [];
		try {
			await updateQuestProgress(
				userId,
				{
					type: stepType,
					index: currentStepIndex,
					...(candidateAltIndex !== undefined ? { altIndex: candidateAltIndex } : {}),
					duration: Math.max(readTimeSeconds, candidateThreshold)
				} as any,
				{ make: 'unknown', model: 'API', os: 'web' },
				bindings,
				{
					waitUntil(promise) {
						waitUntilPromises.push(Promise.resolve(promise));
					}
				}
			);
			await Promise.all(waitUntilPromises);
		} catch (innerError) {
			const status = (innerError as { status?: number }).status;
			if (status && status !== 409) {
				console.warn('Failed to auto-complete read-time quest step:', innerError);
			}
		}
	} catch (error) {
		console.error('Unexpected error in maybeAdvanceReadTimeQuestStep:', error);
	}
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
		const url = new URL(req.url);

		if (req.method === 'DELETE' && url.pathname === '/delete') {
			await this.state.storage.deleteAll();
			this.timer = undefined;
			return new Response(null, { status: 204 });
		}

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

			try {
				await applyField(timer.field, timer.userId, durationMs, timer.metadata || {}, this.env);
			} catch (error) {
				console.error('Error applying field:', error);
			}

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
					await addBadgeProgress(userId, 'articles_read', fieldParameter, bindings.KV, { article });
				}
			}

			// add to articles_read_time
			await addBadgeProgress(userId, 'articles_read_time', duration, bindings.KV, { article });

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

			await maybeAdvanceReadTimeQuestStep(userId, 'articles_read_time', bindings);
			break;
		}
		case 'prompts_read_time': {
			const prompt = toRecord(metadata.prompt) as Partial<Prompt> | undefined;
			const contentId = pickContentId(fieldParameter, prompt?.id);
			const analyticsMetadata = promptAnalyticsMetadata(prompt);

			// mark as read if >30 seconds
			if (duration > 30) {
				if (fieldParameter) {
					await addBadgeProgress(userId, 'prompts_read', fieldParameter, bindings.KV, { prompt });
				}
			}

			// add to prompts_read_time
			await addBadgeProgress(userId, 'prompts_read_time', duration, bindings.KV, { prompt });

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
		case 'activity_read_time': {
			const activity = toRecord(metadata.activity) as Partial<Activity> | undefined;

			// add to activity_read_time
			await addBadgeProgress(userId, 'activity_read_time', duration, bindings.KV, { activity });
			await maybeAdvanceReadTimeQuestStep(userId, 'activity_read_time', bindings);
			break;
		}
	}
}

// returns reading time in seconds either all time or between start and end timestamps (in ms)

export async function getReadTime(
	userId: string,
	tracker: 'prompts_read_time' | 'articles_read_time' | 'activity_read_time',
	kv: KVNamespace,
	start?: number,
	end?: number,
	filter?: (metadata: Record<string, any>) => boolean
) {
	const normalizedUserId = normalizeId(userId);
	const entries = await kv.get<TrackerEntry[]>(
		`user:badge_tracker:${normalizedUserId}:${tracker}`,
		'json'
	);

	if (!entries) return 0;

	if (!start && !end) {
		// return sum of all entries if no start/end provided
		return entries.reduce(
			(total, entry) => total + (typeof entry.value === 'number' ? entry.value : 0),
			0
		);
	}

	const startTime = start ?? 0;
	const endTime = end ?? Date.now();

	// filter entries to those within the specified time range and sum their values
	return entries.reduce((total, entry) => {
		if (
			entry.date >= startTime &&
			entry.date <= endTime &&
			typeof entry.value === 'number' &&
			(!filter || filter(entry.metadata || {}))
		) {
			return total + entry.value;
		}

		return total;
	}, 0);
}
