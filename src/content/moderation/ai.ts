import { Bindings } from '../../util/types';
import { downscaleImageForAI } from '../ferry';
import { getEventImage } from '../../user/submissions';
import { ContentReport, getReport, patchReportStatus, setReportAi, ReportReason } from '../reports';
import { fetchReportableContentText, requestContentRemoval } from '../../util/mantle2';
import { runAI } from '../../util/ai-runtime';

const textSafetyModel = '@cf/meta/llama-guard-3-8b';
const imageCaptionModel = '@cf/llava-hf/llava-1.5-7b-hf';

const SYSTEM_USER_ID = '1';

export type ModerationResult = {
	model: string;
	flagged: boolean;
	confidence: number; // llama-guard is a classifier: 1 unsafe / 0 safe
	labels: string[]; // mapped ReportReason codes
	severe: boolean; // any label in the auto-remove set
};

// MLCommons hazard codes (llama-guard 3) mapped onto our 9 report reasons
const CODE_TO_REASON: Record<string, ReportReason> = {
	S1: 'violence',
	S2: 'illegal',
	S3: 'sexual',
	S4: 'sexual',
	S5: 'other',
	S6: 'other',
	S7: 'other',
	S8: 'illegal',
	S9: 'violence',
	S10: 'hate_speech',
	S11: 'self_harm',
	S12: 'sexual',
	S13: 'misinformation',
	S14: 'illegal'
};

// only these categories auto-remove on a single unsafe verdict; the rest flag for a human admin
const AUTO_REMOVE_REASONS = new Set<ReportReason>(['sexual', 'hate_speech', 'violence']);

function parseGuardOutput(raw: string): { unsafe: boolean; reasons: ReportReason[] } {
	const text = (raw || '').trim();
	if (!/^unsafe/i.test(text)) return { unsafe: false, reasons: [] };

	const codeLine = text.split('\n')[1] || '';
	const reasons = codeLine
		.split(',')
		.map((code) => CODE_TO_REASON[code.trim().toUpperCase()])
		.filter((r): r is ReportReason => !!r);

	return { unsafe: true, reasons: Array.from(new Set(reasons)) };
}

export async function moderateText(env: Bindings, text: string): Promise<ModerationResult> {
	const trimmed = (text || '').slice(0, 4000); // keep within guard context budget
	if (!trimmed.trim()) {
		return { model: textSafetyModel, flagged: false, confidence: 0, labels: [], severe: false };
	}

	let res: { response?: string };
	try {
		res = (await runAI('moderateText', () =>
			env.AI.run(textSafetyModel as any, {
				messages: [{ role: 'user', content: trimmed }]
			})
		)) as { response?: string };
	} catch (err) {
		// fail-safe: a spent ai budget must not auto-remove; leave the content unflagged
		// for human review rather than acting on a garbage/absent verdict
		console.error('moderateText: ai scoring unavailable, degrading to not-flagged', { err });
		return { model: textSafetyModel, flagged: false, confidence: 0, labels: [], severe: false };
	}

	const out = parseGuardOutput(typeof res?.response === 'string' ? res.response : '');
	return {
		model: textSafetyModel,
		flagged: out.unsafe,
		confidence: out.unsafe ? 1 : 0,
		labels: out.reasons,
		severe: out.reasons.some((r) => AUTO_REMOVE_REASONS.has(r))
	};
}

export async function moderateImage(env: Bindings, image: Uint8Array): Promise<ModerationResult> {
	// no server nsfw model: caption the image, then run the caption through the text guard
	const scaled = await downscaleImageForAI(env, image);
	let caption: { description?: string };
	try {
		caption = (await runAI('moderateImage:caption', () =>
			env.AI.run(imageCaptionModel as any, {
				image: [...new Uint8Array(scaled)],
				prompt: 'Describe this image in detail for content safety review.',
				max_tokens: 512
			})
		)) as { description?: string };
	} catch (err) {
		// fail-safe: no caption means no basis to flag; leave for human review
		console.error('moderateImage: captioning unavailable, degrading to not-flagged', { err });
		return { model: imageCaptionModel, flagged: false, confidence: 0, labels: [], severe: false };
	}

	return moderateText(env, caption?.description?.trim() || '');
}

// invoked from POST /v1/reports (background): enrich the report with ai triage labels and, for severe
// verdicts, best-effort auto-remove via mantle2 (which applies the admin/uid-1 strike guard).
export async function moderateReport(env: Bindings, reportId: string): Promise<void> {
	const report = await getReport(env, reportId);
	if (!report || report.status !== 'pending' || report.source !== 'user') return;

	// pre-safeguarded system content is never moderated or struck
	if (report.content_owner_id === SYSTEM_USER_ID) return;

	let result: ModerationResult | null = null;
	try {
		if (report.content_type === 'event_image') {
			const [bytes] = await getEventImage(report.content_id, env);
			if (bytes) result = await moderateImage(env, bytes);
		} else {
			const text = await fetchReportableContentText(
				env,
				report.content_type,
				report.content_id,
				report.parent_id
			);
			if (text) result = await moderateText(env, text);
		}
	} catch (err) {
		console.error('moderateReport: ai scoring failed', { reportId, err });
		return;
	}

	if (!result) return;

	// an admin may have already acted while the model ran — re-read before mutating
	const fresh = await getReport(env, reportId);
	if (!fresh || fresh.status !== 'pending') return;
	await setReportAi(env, reportId, {
		model: result.model,
		confidence: result.confidence,
		labels: result.labels
	});

	if (result.flagged && result.severe) {
		try {
			const removed = await requestContentRemoval(env, reportId);
			if (removed) {
				await patchReportStatus(
					env,
					reportId,
					'auto_removed',
					'ai',
					`auto-removed: ${result.labels.join(', ')}`
				);
			}
		} catch (err) {
			// degrade to a human-reviewed pending report if mantle2 removal is unavailable
			console.error('moderateReport: auto-remove failed', { reportId, err });
		}
	}
}

export type { ContentReport };
