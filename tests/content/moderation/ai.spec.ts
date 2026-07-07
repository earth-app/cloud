import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchReportableContentText, requestContentRemoval, getEventImage } = vi.hoisted(() => ({
	fetchReportableContentText: vi.fn(),
	requestContentRemoval: vi.fn(),
	getEventImage: vi.fn()
}));

vi.mock('../../../src/util/mantle2', () => ({
	fetchReportableContentText,
	requestContentRemoval
}));

vi.mock('../../../src/user/submissions', () => ({
	getEventImage
}));

import { createMockBindings } from '../../helpers/mock-bindings';
import { createMockAiRun } from '../../helpers/mock-ai';
import { moderateText, moderateImage, moderateReport } from '../../../src/content/moderation/ai';
import { createReport, getReport, patchReportStatus } from '../../../src/content/reports';
import { Bindings } from '../../../src/util/types';

const GUARD_MODEL = '@cf/meta/llama-guard-3-8b';

function envGuard(response: string): Bindings {
	return createMockBindings({
		AI: { run: createMockAiRun({ [GUARD_MODEL]: { response } }) } as unknown as Bindings['AI']
	});
}

beforeEach(() => {
	fetchReportableContentText.mockReset().mockResolvedValue('reported text');
	requestContentRemoval.mockReset().mockResolvedValue(true);
	getEventImage.mockReset().mockResolvedValue([new Uint8Array([1, 2, 3]), null, null, null]);
});

describe('moderateText', () => {
	it('returns a not-flagged result for empty input without calling the model', async () => {
		const env = envGuard('unsafe\nS1');
		const result = await moderateText(env, '   ');
		expect(result.flagged).toBe(false);
		expect(result.confidence).toBe(0);
		expect(result.labels).toEqual([]);
		expect(env.AI.run).not.toHaveBeenCalled();
	});

	it('treats a "safe" verdict as not flagged', async () => {
		const result = await moderateText(envGuard('safe'), 'hello world');
		expect(result.flagged).toBe(false);
		expect(result.severe).toBe(false);
		expect(result.labels).toEqual([]);
	});

	it('flags and marks severe for an auto-remove category', async () => {
		const result = await moderateText(envGuard('unsafe\nS10'), 'bad text');
		expect(result.flagged).toBe(true);
		expect(result.confidence).toBe(1);
		expect(result.labels).toEqual(['hate_speech']);
		expect(result.severe).toBe(true);
	});

	it('flags but does not mark severe for a human-review category', async () => {
		const result = await moderateText(envGuard('unsafe\nS13'), 'bad text');
		expect(result.flagged).toBe(true);
		expect(result.labels).toEqual(['misinformation']);
		expect(result.severe).toBe(false);
	});

	it('flags with no labels when the category code is unknown', async () => {
		const result = await moderateText(envGuard('unsafe\nS99'), 'bad text');
		expect(result.flagged).toBe(true);
		expect(result.labels).toEqual([]);
		expect(result.severe).toBe(false);
	});

	it('dedupes multiple codes that map to the same reason', async () => {
		const result = await moderateText(envGuard('unsafe\nS3, S12, S4'), 'bad text');
		expect(result.labels).toEqual(['sexual']);
		expect(result.severe).toBe(true);
	});

	it('retries a transient guard failure and then returns the verdict', async () => {
		let calls = 0;
		const run = vi.fn(async () => {
			calls++;
			if (calls < 2) throw new Error('guard 5xx');
			return { response: 'unsafe\nS10' };
		});
		const env = createMockBindings({ AI: { run } as unknown as Bindings['AI'] });

		const result = await moderateText(env, 'bad text');
		expect(result.flagged).toBe(true);
		expect(result.labels).toEqual(['hate_speech']);
		expect(run).toHaveBeenCalledTimes(2);
	});

	it('fails safe (not flagged, no throw) when the guard is persistently unavailable', async () => {
		const run = vi.fn(async () => {
			throw new Error('guard down');
		});
		const env = createMockBindings({ AI: { run } as unknown as Bindings['AI'] });

		// a persistent AI failure must never auto-flag or throw; degrade to human review
		const result = await moderateText(env, 'possibly bad text');
		expect(result.flagged).toBe(false);
		expect(result.severe).toBe(false);
		expect(result.labels).toEqual([]);
		expect(run).toHaveBeenCalledTimes(3);
	});
});

describe('moderateImage', () => {
	it('captions the image and runs the caption through the text guard', async () => {
		const result = await moderateImage(envGuard('unsafe\nS1'), new Uint8Array([1, 2, 3]));
		expect(result.flagged).toBe(true);
		expect(result.labels).toEqual(['violence']);
		expect(result.severe).toBe(true);
		expect(result.model).toBe(GUARD_MODEL);
	});

	it('passes a benign caption as not flagged', async () => {
		const result = await moderateImage(envGuard('safe'), new Uint8Array([1, 2, 3]));
		expect(result.flagged).toBe(false);
	});
});

describe('moderateReport', () => {
	async function seed(env: Bindings, overrides = {}) {
		const { report } = await createReport(env, {
			content_type: 'prompt',
			content_id: 'c-1',
			reason: 'spam',
			reporter_id: '42',
			...overrides
		});
		return report;
	}

	it('auto-removes severe content and marks the report auto_removed', async () => {
		const env = envGuard('unsafe\nS3');
		const report = await seed(env);

		await moderateReport(env, report.id);

		const fresh = await getReport(env, report.id);
		expect(fresh?.status).toBe('auto_removed');
		expect(fresh?.ai?.labels).toEqual(['sexual']);
		expect(fresh?.ai?.confidence).toBe(1);
		expect(fresh?.action_notes).toContain('sexual');
		expect(requestContentRemoval).toHaveBeenCalledWith(env, report.id);
	});

	it('only attaches ai triage for a flagged but non-severe verdict', async () => {
		const env = envGuard('unsafe\nS13');
		const report = await seed(env);

		await moderateReport(env, report.id);

		const fresh = await getReport(env, report.id);
		expect(fresh?.status).toBe('pending');
		expect(fresh?.ai?.labels).toEqual(['misinformation']);
		expect(requestContentRemoval).not.toHaveBeenCalled();
	});

	it('attaches ai triage with no labels for a safe verdict', async () => {
		const env = envGuard('safe');
		const report = await seed(env);

		await moderateReport(env, report.id);

		const fresh = await getReport(env, report.id);
		expect(fresh?.status).toBe('pending');
		expect(fresh?.ai?.labels).toEqual([]);
		expect(requestContentRemoval).not.toHaveBeenCalled();
	});

	it('keeps the report pending when content removal fails', async () => {
		requestContentRemoval.mockResolvedValue(false);
		const env = envGuard('unsafe\nS3');
		const report = await seed(env);

		await moderateReport(env, report.id);

		const fresh = await getReport(env, report.id);
		expect(fresh?.status).toBe('pending');
		expect(fresh?.ai?.labels).toEqual(['sexual']);
	});

	it('skips system-owned content entirely', async () => {
		const env = envGuard('unsafe\nS3');
		const report = await seed(env, { content_owner_id: '1' });

		await moderateReport(env, report.id);

		const fresh = await getReport(env, report.id);
		expect(fresh?.ai).toBeUndefined();
		expect(fetchReportableContentText).not.toHaveBeenCalled();
		expect(requestContentRemoval).not.toHaveBeenCalled();
	});

	it('skips reports that are no longer pending', async () => {
		const env = envGuard('unsafe\nS3');
		const report = await seed(env);
		await patchReportStatus(env, report.id, 'dismissed');

		await moderateReport(env, report.id);

		expect(fetchReportableContentText).not.toHaveBeenCalled();
	});

	it('skips ai-sourced reports', async () => {
		const env = envGuard('unsafe\nS3');
		const report = await seed(env, { source: 'ai' });

		await moderateReport(env, report.id);

		expect(fetchReportableContentText).not.toHaveBeenCalled();
	});

	it('does nothing when the reported content text is gone', async () => {
		fetchReportableContentText.mockResolvedValue('');
		const env = envGuard('unsafe\nS3');
		const report = await seed(env);

		await moderateReport(env, report.id);

		const fresh = await getReport(env, report.id);
		expect(fresh?.ai).toBeUndefined();
		expect(fresh?.status).toBe('pending');
		expect(requestContentRemoval).not.toHaveBeenCalled();
	});

	it('scores event_image reports through the image pipeline', async () => {
		const env = envGuard('unsafe\nS1');
		const report = await seed(env, { content_type: 'event_image', content_id: 'sub-1' });

		await moderateReport(env, report.id);

		expect(getEventImage).toHaveBeenCalledWith('sub-1', env);
		expect(fetchReportableContentText).not.toHaveBeenCalled();
		const fresh = await getReport(env, report.id);
		expect(fresh?.status).toBe('auto_removed');
		expect(fresh?.ai?.labels).toEqual(['violence']);
	});

	it('returns quietly when ai scoring throws', async () => {
		fetchReportableContentText.mockRejectedValue(new Error('boom'));
		const env = envGuard('unsafe\nS3');
		const report = await seed(env);

		await expect(moderateReport(env, report.id)).resolves.toBeUndefined();
		const fresh = await getReport(env, report.id);
		expect(fresh?.ai).toBeUndefined();
		expect(fresh?.status).toBe('pending');
	});

	it('returns quietly for a missing report', async () => {
		const env = envGuard('safe');
		await expect(moderateReport(env, 'does-not-exist')).resolves.toBeUndefined();
	});
});
