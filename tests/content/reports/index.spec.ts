import { beforeEach, describe, expect, it } from 'vitest';
import { createMockBindings } from '../../helpers/mock-bindings';
import {
	createReport,
	getReport,
	setReportAi,
	listReports,
	patchReportStatus,
	deleteReport,
	expireStaleReports,
	isReportableContentType,
	isReportReason,
	isReportStatus,
	CreateReportInput
} from '../../../src/content/reports';
import { Bindings } from '../../../src/util/types';

let env: Bindings;

function baseInput(overrides: Partial<CreateReportInput> = {}): CreateReportInput {
	return {
		content_type: 'prompt',
		content_id: 'c-1',
		reason: 'spam',
		reporter_id: '42',
		...overrides
	};
}

beforeEach(() => {
	env = createMockBindings();
});

describe('report type guards', () => {
	it('accepts known content types and rejects unknown ones', () => {
		expect(isReportableContentType('prompt')).toBe(true);
		expect(isReportableContentType('event_image')).toBe(true);
		expect(isReportableContentType('comment')).toBe(false);
		expect(isReportableContentType(undefined)).toBe(false);
		expect(isReportableContentType(5)).toBe(false);
	});

	it('accepts known reasons and statuses', () => {
		expect(isReportReason('hate_speech')).toBe(true);
		expect(isReportReason('nonsense')).toBe(false);
		expect(isReportStatus('pending')).toBe(true);
		expect(isReportStatus('auto_removed')).toBe(true);
		expect(isReportStatus('closed')).toBe(false);
	});
});

describe('createReport', () => {
	it('creates a fresh pending report and indexes it', async () => {
		const { report, deduped } = await createReport(env, baseInput());

		expect(deduped).toBe(false);
		expect(report.status).toBe('pending');
		expect(report.report_count).toBe(1);
		expect(report.source).toBe('user');
		expect(report.reporter_id).toBe('42');
		expect(report.id).toMatch(/^[0-9a-f]{32}$/);

		const stored = await getReport(env, report.id);
		expect(stored?.id).toBe(report.id);

		const { reports } = await listReports(env, 'pending');
		expect(reports.map((r) => r.id)).toContain(report.id);
	});

	it('truncates an overlong description to 1024 chars', async () => {
		const { report } = await createReport(env, baseInput({ description: 'x'.repeat(2000) }));
		expect(report.description).toHaveLength(1024);
	});

	it('defaults reporter_id to null for anonymous reports', async () => {
		const { report } = await createReport(
			env,
			baseInput({ reporter_id: undefined, reporter_ip_hash: 'iphash' })
		);
		expect(report.reporter_id).toBeNull();
		expect(report.reporter_ip_hash).toBe('iphash');
	});

	it('coerces an invalid source to user', async () => {
		const { report } = await createReport(env, baseInput({ source: 'bogus' as unknown as 'user' }));
		expect(report.source).toBe('user');
	});

	it('dedups a second report on the same pending content (same reporter)', async () => {
		const first = await createReport(env, baseInput());
		const second = await createReport(env, baseInput());

		expect(second.deduped).toBe(true);
		expect(second.report.id).toBe(first.report.id);
		expect(second.report.report_count).toBe(2);

		// no duplicate row added to the index
		const { reports } = await listReports(env, 'pending');
		expect(reports.filter((r) => r.id === first.report.id)).toHaveLength(1);
	});

	it('dedups a different reporter into the same pending report as corroboration', async () => {
		const first = await createReport(env, baseInput({ reporter_id: 'a' }));
		const second = await createReport(env, baseInput({ reporter_id: 'b' }));

		expect(second.deduped).toBe(true);
		expect(second.report.id).toBe(first.report.id);
		expect(second.report.report_count).toBe(2);
	});

	it('creates a new report once the prior one is resolved away from pending', async () => {
		const first = await createReport(env, baseInput());
		await patchReportStatus(env, first.report.id, 'dismissed');

		const second = await createReport(env, baseInput());
		expect(second.deduped).toBe(false);
		expect(second.report.id).not.toBe(first.report.id);
	});
});

describe('setReportAi', () => {
	it('attaches ai triage metadata without changing status or index', async () => {
		const { report } = await createReport(env, baseInput());
		const updated = await setReportAi(env, report.id, {
			model: 'guard',
			confidence: 1,
			labels: ['sexual']
		});

		expect(updated?.ai).toEqual({ model: 'guard', confidence: 1, labels: ['sexual'] });
		expect(updated?.status).toBe('pending');

		const { reports } = await listReports(env, 'pending');
		expect(reports.find((r) => r.id === report.id)?.ai?.model).toBe('guard');
	});

	it('returns null for a missing report', async () => {
		expect(await setReportAi(env, 'nope', { model: 'm', confidence: 0, labels: [] })).toBeNull();
	});
});

describe('listReports', () => {
	it('returns reports newest-first across pages', async () => {
		const ids: string[] = [];
		for (let i = 0; i < 5; i++) {
			const { report } = await createReport(env, baseInput({ content_id: `c-${i}` }));
			report.created_at = i; // oldest..newest by creation order
			await env.KV.put(`report:item:${report.id}`, JSON.stringify(report));
			ids.push(report.id);
		}

		const page1 = await listReports(env, 'pending', 2);
		expect(page1.reports.map((r) => r.content_id)).toEqual(['c-4', 'c-3']);
		expect(page1.cursor).toBe('2');
		expect(page1.total).toBe(5);

		const page2 = await listReports(env, 'pending', 2, page1.cursor);
		expect(page2.reports.map((r) => r.content_id)).toEqual(['c-2', 'c-1']);
		expect(page2.cursor).toBe('4');

		const page3 = await listReports(env, 'pending', 2, page2.cursor);
		expect(page3.reports.map((r) => r.content_id)).toEqual(['c-0']);
		expect(page3.cursor).toBeUndefined();
	});

	it('returns an empty list for a status with no reports', async () => {
		const { reports, cursor, total } = await listReports(env, 'actioned');
		expect(reports).toEqual([]);
		expect(cursor).toBeUndefined();
		expect(total).toBe(0);
	});

	it('skips ids whose item was deleted out from under the index', async () => {
		const { report } = await createReport(env, baseInput());
		await env.KV.delete(`report:item:${report.id}`);
		const { reports } = await listReports(env, 'pending');
		expect(reports).toEqual([]);
	});
});

describe('patchReportStatus', () => {
	it('moves the report between status indexes and stamps review metadata', async () => {
		const { report } = await createReport(env, baseInput());

		const updated = await patchReportStatus(env, report.id, 'actioned', 'admin-1', 'removed');
		expect(updated?.status).toBe('actioned');
		expect(updated?.reviewed_by).toBe('admin-1');
		expect(updated?.action_notes).toBe('removed');
		expect(typeof updated?.reviewed_at).toBe('number');

		expect((await listReports(env, 'pending')).reports).toHaveLength(0);
		expect((await listReports(env, 'actioned')).reports.map((r) => r.id)).toEqual([report.id]);
	});

	it('unlinks the active-content key when resolved so new reports can be filed', async () => {
		const { report } = await createReport(env, baseInput());
		expect(await env.KV.get('report:content:prompt:c-1')).toBe(report.id);

		await patchReportStatus(env, report.id, 'dismissed');
		expect(await env.KV.get('report:content:prompt:c-1')).toBeNull();
	});

	it('does not stamp reviewed_at when staying pending', async () => {
		const { report } = await createReport(env, baseInput());
		const updated = await patchReportStatus(env, report.id, 'pending', 'admin-1');
		expect(updated?.reviewed_at).toBeUndefined();
	});

	it('returns null for a missing report', async () => {
		expect(await patchReportStatus(env, 'nope', 'dismissed')).toBeNull();
	});
});

describe('deleteReport', () => {
	it('removes the item, its index entry, and the content link', async () => {
		const { report } = await createReport(env, baseInput());

		expect(await deleteReport(env, report.id)).toBe(true);
		expect(await getReport(env, report.id)).toBeNull();
		expect((await listReports(env, 'pending')).reports).toHaveLength(0);
		expect(await env.KV.get('report:content:prompt:c-1')).toBeNull();
	});

	it('returns false for a missing report', async () => {
		expect(await deleteReport(env, 'nope')).toBe(false);
	});

	it('leaves a relinked content key intact when deleting an old report', async () => {
		const first = await createReport(env, baseInput());
		await patchReportStatus(env, first.report.id, 'dismissed');
		const second = await createReport(env, baseInput());

		// deleting the resolved first report must not drop the link the second report now owns
		await deleteReport(env, first.report.id);
		expect(await env.KV.get('report:content:prompt:c-1')).toBe(second.report.id);
	});
});

describe('expireStaleReports', () => {
	it('expires pending reports older than 7 days and leaves fresh ones alone', async () => {
		const now = 1_000_000_000_000;
		const sevenDays = 7 * 24 * 60 * 60 * 1000;

		const stale = await createReport(env, baseInput({ content_id: 'stale' }));
		stale.report.created_at = now - sevenDays - 1;
		await env.KV.put(`report:item:${stale.report.id}`, JSON.stringify(stale.report));

		const fresh = await createReport(env, baseInput({ content_id: 'fresh' }));
		fresh.report.created_at = now - 1000;
		await env.KV.put(`report:item:${fresh.report.id}`, JSON.stringify(fresh.report));

		const expired = await expireStaleReports(env, now);
		expect(expired).toBe(1);

		expect((await getReport(env, stale.report.id))?.status).toBe('expired');
		expect((await getReport(env, fresh.report.id))?.status).toBe('pending');
		expect((await listReports(env, 'pending')).reports.map((r) => r.id)).toEqual([fresh.report.id]);
	});

	it('returns 0 when there are no pending reports', async () => {
		expect(await expireStaleReports(env)).toBe(0);
	});

	it('prunes index entries that point at a missing item', async () => {
		const { report } = await createReport(env, baseInput());
		await env.KV.delete(`report:item:${report.id}`);

		expect(await expireStaleReports(env, Date.now())).toBe(0);
		expect((await listReports(env, 'pending')).reports).toHaveLength(0);
	});
});
