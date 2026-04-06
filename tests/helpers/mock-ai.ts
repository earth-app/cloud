import { vi } from 'vitest';

export type MockAiOverrides = Record<string, unknown | ((input: unknown) => unknown)>;

const DEFAULT_EMBEDDING = [0.9, 0.1, 0.2, 0.3, 0.4];

function normalizeModel(model: unknown): string {
	return typeof model === 'string' ? model : '';
}

function asResponse(value: unknown): unknown {
	if (typeof value === 'function') {
		return (value as (input: unknown) => unknown)({});
	}
	return value;
}

export function createMockAiRun(overrides: MockAiOverrides = {}) {
	return vi.fn(async (model: unknown, input: unknown) => {
		const modelName = normalizeModel(model);
		if (modelName in overrides) {
			const override = overrides[modelName];
			return typeof override === 'function'
				? (override as (i: unknown) => unknown)(input)
				: asResponse(override);
		}

		if (modelName.includes('bge-m3')) {
			return { data: [DEFAULT_EMBEDDING] };
		}

		if (modelName.includes('bge-reranker-base')) {
			const contexts = (input as { contexts?: unknown[] })?.contexts || [];
			return {
				response: contexts.map((_, id) => ({ id, score: Math.max(0.1, 1 - id * 0.05) }))
			};
		}

		if (modelName.includes('llava')) {
			return {
				description:
					'A bright outdoor photo showing nature, community activity, and a clear focal subject.'
			};
		}

		if (modelName.includes('whisper')) {
			return {
				text: 'This recording clearly explains the requested topic and includes relevant details.'
			};
		}

		if (modelName.includes('detr-resnet-50')) {
			return {
				result: [
					{ label: 'dog', score: 0.95, box: { xmin: 10, ymin: 15, xmax: 110, ymax: 140 } },
					{ label: 'tree', score: 0.82, box: { xmin: 120, ymin: 25, xmax: 220, ymax: 180 } }
				]
			};
		}

		if (modelName.includes('resnet-50')) {
			return [
				{ label: 'broccoli, cruciferous vegetable', score: 0.93 },
				{ label: 'carrot', score: 0.21 }
			];
		}

		if (modelName.includes('gpt-oss-120b')) {
			return {
				output: [
					{
						id: 'msg_1',
						type: 'message',
						content: [
							{
								type: 'output_text',
								text: 'What small action can you take today to make your neighborhood cleaner?'
							}
						]
					}
				]
			};
		}

		if (modelName.includes('mistral-small-3.1-24b-instruct')) {
			const messages = (input as { messages?: Array<{ content?: string }> })?.messages || [];
			const firstSystem = messages[0]?.content || '';
			if (firstSystem.toLowerCase().includes('title')) {
				return { response: 'Sustainable Cities and Everyday Climate Action' };
			}
			return {
				response:
					'Sustainable development depends on practical actions people can apply in everyday life. ' +
					'This article explores transportation choices, waste reduction habits, and local policy engagement. ' +
					'By combining scientific context with clear examples, it explains how neighborhoods can reduce emissions, improve resilience, and support long-term public health. ' +
					'It also highlights the role of community projects, shared infrastructure, and data-informed planning to make climate progress measurable and collaborative.'
			};
		}

		if (modelName.includes('llama-3.2-3b-instruct')) {
			return { response: 'sustainable cities' };
		}

		if (modelName.includes('llama-3.1-8b-instruct-fp8')) {
			return { response: 'NATURE, TECHNOLOGY' };
		}

		if (modelName.includes('llama-4-scout-17b-16e-instruct')) {
			return {
				response:
					'Communities can make meaningful environmental progress through local action, shared learning, and measurable goals.'
			};
		}

		return {};
	});
}

export function createEarthApiFetchMock() {
	return vi.fn(async (input: RequestInfo | URL) => {
		const rawUrl =
			typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
		const url = new URL(rawUrl);
		const path = url.pathname;
		const limit = Number(url.searchParams.get('limit') || '1');
		const page = Number(url.searchParams.get('page') || '1');

		if (path === '/v2/activities') {
			return Response.json({
				page,
				total: 323,
				limit,
				items: [
					{
						id: 'gourd_art',
						name: 'Gourd Art',
						description:
							'Gourd art transforms hard-shelled fruit into decorative and functional pieces through carving, painting, and engraving.',
						aliases: ['gourding'],
						activity_types: ['ART']
					}
				]
			});
		}

		if (path === '/v2/articles') {
			return Response.json({
				page,
				total: 1058,
				limit,
				items: [
					{
						id: '000000000000000000007734',
						title: 'Relaxing Bedside Care: A Holiday-Ready Video Guide',
						description:
							'An evidence-based overview of nursing education resources designed for high-demand periods.',
						tags: ['HEALTH', 'WORK'],
						content:
							'This article reviews practical techniques nurses can apply during busy shifts while maintaining patient empathy and safety.',
						ocean: {
							title: 'Relaxing Bedside Care',
							author: 'Clinical Team',
							source: 'Nursing Journal',
							url: 'https://example.com/ocean/bedside-care',
							keywords: ['care', 'nursing'],
							date: '2026-01-01',
							links: {}
						}
					}
				]
			});
		}

		if (path === '/v2/prompts') {
			return Response.json({
				page,
				total: 222,
				limit,
				items: [
					{
						id: '000000000000000000007735',
						prompt: 'What separates perception of sound from physical origins?',
						owner_id: '000000000000000000000001',
						visibility: 'PUBLIC'
					}
				]
			});
		}

		if (path === '/v2/events') {
			return Response.json({
				page,
				total: 78,
				limit,
				items: [
					{
						id: '000000000000000000007565',
						name: "Arlington (TX)'s 150th Birthday",
						description:
							'Arlington celebrates another milestone with community history, local identity, and public events.',
						date: Date.now(),
						end_date: Date.now() + 86400000,
						type: 'ONLINE',
						visibility: 'PUBLIC',
						activities: [{ type: 'activity_type', value: 'NATURE' }],
						fields: {}
					}
				]
			});
		}

		return new Response('not mocked', { status: 404 });
	});
}
