import { ArticleQuizQuestion } from '../content/boat';
import { Bindings, Activity, Prompt, Article, Event } from './types';
import { normalizeId } from './util';

export async function getActivity(id: string, bindings: Bindings): Promise<Activity | null> {
	const url = `${bindings.MANTLE_URL || 'https://api.earth-app.com'}/v2/activities/${id}`;

	const response = await fetch(url, {
		method: 'GET',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${bindings.ADMIN_API_KEY}`
		}
	});
	const activity = await response.json<Activity>();

	if (!activity || !activity.id) {
		return null;
	}

	return activity;
}

export async function retrieveActivities(bindings: Bindings): Promise<Activity[]> {
	const root = bindings.MANTLE_URL || 'https://api.earth-app.com';
	const limit = 100;
	let page = 1;
	const allActivities: Activity[] = [];

	// Fetch first page to get total count
	const firstUrl = `${root}/v2/activities?limit=${limit}&page=${page}`;
	const firstRes = await fetch(firstUrl, {
		method: 'GET',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${bindings.ADMIN_API_KEY}`
		}
	});

	if (!firstRes.ok) {
		const errorText = await firstRes.text();
		console.error(
			`Failed to retrieve activities: ${firstRes.status} ${firstRes.statusText} - ${errorText}`
		);
		return [];
	}

	const firstData = await firstRes.json<{ items: Activity[]; total: number; page: number }>();
	allActivities.push(...(firstData.items || []));
	const total = firstData.total || 0;
	const totalPages = Math.ceil(total / limit);

	// Fetch remaining pages if needed
	page++;
	while (page <= totalPages) {
		const url = `${root}/v2/activities?limit=${limit}&page=${page}`;
		const res = await fetch(url, {
			method: 'GET',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${bindings.ADMIN_API_KEY}`
			}
		});

		if (!res.ok) {
			console.error(`Failed to fetch activities page ${page}`);
			break;
		}

		const data = await res.json<{ items: Activity[] }>();
		allActivities.push(...(data.items || []));
		page++;
	}

	console.log(`Retrieved ${allActivities.length} total activities`);
	return allActivities;
}

export async function postActivity(bindings: Bindings, activity: Activity): Promise<Activity> {
	const url = `${bindings.MANTLE_URL || 'https://api.earth-app.com'}/v2/activities`;
	const res = await fetch(url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${bindings.ADMIN_API_KEY}`
		},
		body: JSON.stringify(activity)
	});

	if (!res.ok) {
		const errorText = await res.text();
		throw new Error(`Failed to post activity: ${res.status} ${res.statusText} - ${errorText}`);
	}

	const data = await res.json<Activity>();
	if (!data || !data.id) {
		throw new Error('Failed to create activity, no ID returned');
	}

	return data;
}

export async function postPrompt(prompt: string, bindings: Bindings): Promise<Prompt> {
	if (!prompt || prompt.length < 10) {
		throw new Error('Prompt must be at least 10 characters long');
	}

	const url = `${bindings.MANTLE_URL || 'https://api.earth-app.com'}/v2/prompts`;
	const res = await fetch(url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${bindings.ADMIN_API_KEY}`
		},
		body: JSON.stringify({ prompt, visibility: 'PUBLIC', censor: true })
	});

	if (!res.ok) {
		const errorText = await res.text();
		throw new Error(`Failed to post prompt: ${res.status} ${res.statusText} - ${errorText}`);
	}

	const data = await res.json<Prompt>();
	if (!data || !data.id) {
		throw new Error('Failed to create prompt, no ID returned');
	}

	return data;
}

export async function postArticle(
	article: Pick<Article, 'title' | 'description' | 'content' | 'ocean'>,
	quiz: ArticleQuizQuestion[] | null,
	bindings: Bindings
): Promise<Article> {
	const url = `${bindings.MANTLE_URL || 'https://api.earth-app.com'}/v2/articles`;
	const res = await fetch(url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${bindings.ADMIN_API_KEY}`
		},
		body: JSON.stringify({
			...article,
			censor: true
		})
	});

	if (!res.ok) {
		const errorText = await res.text();
		throw new Error(`Failed to post article: ${res.status} ${res.statusText} - ${errorText}`);
	}

	const data = await res.json<Article>();
	if (!data || !data.id) {
		throw new Error('Failed to create article, no ID returned');
	}

	// add quiz to KV
	if (quiz) {
		const key = `article:quiz:${normalizeId(data.id)}`;
		await bindings.KV.put(key, JSON.stringify(quiz), { expirationTtl: 60 * 60 * 12 * 29 }); // 14.5 days (articles are deleted after 2 weeks)
	}

	return data;
}

export async function getEvent(id: string, bindings: Bindings): Promise<Event | null> {
	const url = `${bindings.MANTLE_URL || 'https://api.earth-app.com'}/v2/events/${id}`;

	const response = await fetch(url, {
		method: 'GET',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${bindings.ADMIN_API_KEY}`
		}
	});
	const event = await response.json<Event>();

	if (!event || !event.id) {
		return null;
	}

	return event;
}

// candidate text fields across reportable content types (prompt/article/event/response/user)
const REPORTABLE_TEXT_KEYS = [
	'title',
	'description',
	'content',
	'prompt',
	'response',
	'text',
	'name',
	'bio',
	'summary'
];

function extractReportableText(obj: unknown): string {
	if (!obj || typeof obj !== 'object') return '';
	const record = obj as Record<string, unknown>;
	const parts: string[] = [];
	for (const key of REPORTABLE_TEXT_KEYS) {
		const value = record[key];
		if (typeof value === 'string' && value.trim()) parts.push(value.trim());
	}
	return parts.join('\n').slice(0, 4000);
}

// fetch the reported content's text so cloud moderation can score it without a mantle2-side change
export async function fetchReportableContentText(
	bindings: Bindings,
	type: string,
	id: string,
	parentId?: string
): Promise<string> {
	const root = bindings.MANTLE_URL || 'https://api.earth-app.com';

	let path: string;
	switch (type) {
		case 'prompt':
			path = `/v2/prompts/${id}`;
			break;
		case 'prompt_response':
			path = `/v2/prompts/${parentId}/responses/${id}`;
			break;
		case 'article':
			path = `/v2/articles/${id}`;
			break;
		case 'event':
			path = `/v2/events/${id}`;
			break;
		case 'user':
			path = `/v2/users/${id}`;
			break;
		default:
			return '';
	}

	try {
		const res = await fetch(`${root}${path}`, {
			headers: { Authorization: `Bearer ${bindings.ADMIN_API_KEY}` }
		});
		if (!res.ok) return '';
		return extractReportableText(await res.json());
	} catch {
		return '';
	}
}

export async function requestContentRemoval(
	bindings: Bindings,
	reportId: string
): Promise<boolean> {
	const root = bindings.MANTLE_URL || 'https://api.earth-app.com';
	try {
		const res = await fetch(`${root}/v2/reports/${reportId}`, {
			method: 'PATCH',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${bindings.ADMIN_API_KEY}`
			},
			body: JSON.stringify({
				action: 'delete_content',
				notes: 'AI auto-removed (server moderation)'
			})
		});
		return res.ok;
	} catch {
		return false;
	}
}
