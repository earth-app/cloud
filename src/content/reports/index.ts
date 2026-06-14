import { Bindings } from '../../util/types';

export const REPORTABLE_CONTENT_TYPES = [
	'prompt',
	'prompt_response',
	'article',
	'event',
	'event_image',
	'user'
] as const;
export type ReportableContentType = (typeof REPORTABLE_CONTENT_TYPES)[number];

export const REPORT_REASONS = [
	'hate_speech',
	'harassment',
	'sexual',
	'violence',
	'spam',
	'misinformation',
	'self_harm',
	'illegal',
	'other'
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export const REPORT_STATUSES = [
	'pending',
	'dismissed',
	'actioned',
	'auto_removed',
	'expired'
] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export type ReportSource = 'user' | 'ai';

export type ContentReport = {
	id: string;
	content_type: ReportableContentType;
	content_id: string;
	parent_id?: string; // parent prompt for prompt_response, parent event for event_image
	content_owner_id?: string;
	reason: ReportReason;
	description?: string; // <=1024, already censored by mantle2
	reporter_id?: string | null; // null = anonymous
	reporter_ip_hash?: string;
	source: ReportSource;
	ai?: { model: string; confidence: number; labels: string[] };
	status: ReportStatus;
	report_count: number;
	created_at: number; // epoch ms
	updated_at: number;
	reviewed_by?: string;
	reviewed_at?: number;
	action_notes?: string;
};

export type CreateReportInput = {
	content_type: ReportableContentType;
	content_id: string;
	parent_id?: string;
	content_owner_id?: string;
	reason: ReportReason;
	description?: string;
	reporter_id?: string | null;
	reporter_ip_hash?: string;
	source?: ReportSource;
	ai?: { model: string; confidence: number; labels: string[] };
};

const ITEM_KEY = (id: string) => `report:item:${id}`;
const CONTENT_KEY = (type: string, id: string) => `report:content:${type}:${id}`;
const INDEX_KEY = (status: ReportStatus) => `report:index:${status}`;

const DESCRIPTION_MAX = 1024;

export function isReportableContentType(value: unknown): value is ReportableContentType {
	return (
		typeof value === 'string' && (REPORTABLE_CONTENT_TYPES as readonly string[]).includes(value)
	);
}

export function isReportReason(value: unknown): value is ReportReason {
	return typeof value === 'string' && (REPORT_REASONS as readonly string[]).includes(value);
}

export function isReportStatus(value: unknown): value is ReportStatus {
	return typeof value === 'string' && (REPORT_STATUSES as readonly string[]).includes(value);
}

async function readIndex(env: Bindings, status: ReportStatus): Promise<string[]> {
	const raw = await env.KV.get(INDEX_KEY(status));
	if (!raw) return [];
	try {
		const ids = JSON.parse(raw);
		return Array.isArray(ids) ? (ids as string[]) : [];
	} catch {
		return [];
	}
}

async function writeIndex(env: Bindings, status: ReportStatus, ids: string[]): Promise<void> {
	if (ids.length === 0) {
		await env.KV.delete(INDEX_KEY(status));
		return;
	}
	await env.KV.put(INDEX_KEY(status), JSON.stringify(ids));
}

async function addToIndex(env: Bindings, status: ReportStatus, id: string): Promise<void> {
	const ids = await readIndex(env, status);
	if (!ids.includes(id)) {
		ids.push(id);
		await writeIndex(env, status, ids);
	}
}

async function removeFromIndex(env: Bindings, status: ReportStatus, id: string): Promise<void> {
	const ids = await readIndex(env, status);
	const next = ids.filter((x) => x !== id);
	if (next.length !== ids.length) {
		await writeIndex(env, status, next);
	}
}

export async function getReport(env: Bindings, id: string): Promise<ContentReport | null> {
	return env.KV.get<ContentReport>(ITEM_KEY(id), 'json');
}

// attach ai triage metadata without touching status/index (used by on-report moderation)
export async function setReportAi(
	env: Bindings,
	id: string,
	ai: ContentReport['ai']
): Promise<ContentReport | null> {
	const report = await getReport(env, id);
	if (!report) return null;
	report.ai = ai;
	report.updated_at = Date.now();
	await env.KV.put(ITEM_KEY(id), JSON.stringify(report));
	return report;
}

// dedup: while a report on this content is still pending, any later report (same or different
// reporter) folds into it and bumps report_count so admins see corroboration, not duplicate rows.
export async function createReport(
	env: Bindings,
	input: CreateReportInput
): Promise<{ report: ContentReport; deduped: boolean }> {
	const now = Date.now();
	const source: ReportSource = input.source === 'ai' ? 'ai' : 'user';

	const description =
		typeof input.description === 'string' ? input.description.slice(0, DESCRIPTION_MAX) : undefined;

	const existingId = await env.KV.get(CONTENT_KEY(input.content_type, input.content_id));
	if (existingId) {
		const existing = await getReport(env, existingId);
		if (existing && existing.status === 'pending') {
			existing.report_count += 1;
			existing.updated_at = now;
			await env.KV.put(ITEM_KEY(existing.id), JSON.stringify(existing));
			return { report: existing, deduped: true };
		}
	}

	const id = crypto.randomUUID().replace(/-/g, '');
	const report: ContentReport = {
		id,
		content_type: input.content_type,
		content_id: input.content_id,
		parent_id: input.parent_id,
		content_owner_id: input.content_owner_id,
		reason: input.reason,
		description,
		reporter_id: input.reporter_id ?? null,
		reporter_ip_hash: input.reporter_ip_hash,
		source,
		ai: input.ai,
		status: 'pending',
		report_count: 1,
		created_at: now,
		updated_at: now
	};

	await Promise.all([
		env.KV.put(ITEM_KEY(id), JSON.stringify(report)),
		env.KV.put(CONTENT_KEY(input.content_type, input.content_id), id),
		addToIndex(env, 'pending', id)
	]);

	return { report, deduped: false };
}

export async function listReports(
	env: Bindings,
	status: ReportStatus,
	limit: number = 50,
	cursor?: string
): Promise<{ reports: ContentReport[]; cursor?: string }> {
	const ids = await readIndex(env, status);
	// the index is append-order (oldest first), so walk it in reverse to page newest-first
	const ordered = ids.slice().reverse();
	const start = cursor ? Math.max(0, parseInt(cursor, 10) || 0) : 0;
	const slice = ordered.slice(start, start + limit);

	const reports = (await Promise.all(slice.map((id) => getReport(env, id)))).filter(
		(r): r is ContentReport => r !== null
	);

	// newest first within the page too (guards against insertion/clock skew)
	reports.sort((a, b) => b.created_at - a.created_at);

	const next = start + limit;
	return {
		reports,
		cursor: next < ids.length ? String(next) : undefined
	};
}

// move a report between status indexes, set review metadata, keep the content link in sync.
// resolving away from pending unlinks the content key so future reports start fresh.
export async function patchReportStatus(
	env: Bindings,
	id: string,
	status: ReportStatus,
	reviewedBy?: string,
	actionNotes?: string
): Promise<ContentReport | null> {
	const report = await getReport(env, id);
	if (!report) return null;

	const previous = report.status;
	report.status = status;
	report.updated_at = Date.now();
	if (reviewedBy !== undefined) report.reviewed_by = reviewedBy;
	if (actionNotes !== undefined) report.action_notes = actionNotes;
	if (status !== 'pending') {
		report.reviewed_at = Date.now();
	}

	await env.KV.put(ITEM_KEY(id), JSON.stringify(report));

	if (previous !== status) {
		await Promise.all([removeFromIndex(env, previous, id), addToIndex(env, status, id)]);
	}

	// once resolved, drop the active-content link so a new report can be filed later
	if (status !== 'pending') {
		const linked = await env.KV.get(CONTENT_KEY(report.content_type, report.content_id));
		if (linked === id) {
			await env.KV.delete(CONTENT_KEY(report.content_type, report.content_id));
		}
	}

	return report;
}

export async function deleteReport(env: Bindings, id: string): Promise<boolean> {
	const report = await getReport(env, id);
	if (!report) return false;

	const linked = await env.KV.get(CONTENT_KEY(report.content_type, report.content_id));
	await Promise.all([
		env.KV.delete(ITEM_KEY(id)),
		removeFromIndex(env, report.status, id),
		linked === id
			? env.KV.delete(CONTENT_KEY(report.content_type, report.content_id))
			: Promise.resolve()
	]);

	return true;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// cron entry: expire pending reports with no admin action for 7 days and unlink their content key
export async function expireStaleReports(env: Bindings, now: number = Date.now()): Promise<number> {
	const ids = await readIndex(env, 'pending');
	if (ids.length === 0) return 0;

	let expired = 0;
	for (const id of ids) {
		const report = await getReport(env, id);
		if (!report) {
			await removeFromIndex(env, 'pending', id);
			continue;
		}
		if (report.status === 'pending' && now - report.created_at > SEVEN_DAYS_MS) {
			await patchReportStatus(env, id, 'expired');
			expired++;
		}
	}

	return expired;
}
