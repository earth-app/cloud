import { describe, expect, it } from 'vitest';
import { MockKVNamespace } from '../../helpers/mock-kv';
import {
	getMasteredMetadata,
	getMasteryQuest,
	isBadgeMastered,
	isMasteryLocked,
	labelsForBadge,
	lockActiveMasteryIfApplicable,
	lockMasteryQuest,
	markBadgeMastered,
	masteryBadgeIdFromQuestId,
	MASTERY_QUEST_ID_PREFIX,
	masteryQuestId,
	masterySpec
} from '../../../src/user/badges/mastery';
import { badges } from '../../../src/user/badges';
import {
	badgeMasteryAiSchema,
	MasteryValidationContext,
	validateBadgeMasterySteps
} from '../../../src/util/ai';
import { ActivityType, Rarity } from '../../../src/util/types';

const exampleBadge = badges.find((b) => b.id === 'article_enthusiast')!;

function ctxFor(
	rarity: Rarity = 'normal',
	overrides: Partial<MasteryValidationContext> = {}
): MasteryValidationContext {
	const spec = masterySpec(rarity);
	return {
		badge: {
			id: 'article_enthusiast',
			name: 'Article Enthusiast',
			description: 'Read 10 articles',
			rarity,
			tracker_id: 'articles_read'
		},
		stepCount: spec.stepCount,
		stepRewardCap: spec.stepRewardCap,
		allowedLabels: ['book_jacket', 'envelope'],
		allowedActivityTypes: ['HOBBY', 'LEARNING', 'STUDY'] as ActivityType[],
		...overrides
	};
}

describe('mastery: spec table', () => {
	it('returns correct step count and reward per rarity', () => {
		expect(masterySpec('normal')).toEqual({ stepCount: 4, reward: 500, stepRewardCap: 125 });
		expect(masterySpec('rare')).toEqual({ stepCount: 6, reward: 1000, stepRewardCap: 166 });
		expect(masterySpec('amazing')).toEqual({ stepCount: 8, reward: 2000, stepRewardCap: 250 });
		expect(masterySpec('green')).toEqual({ stepCount: 10, reward: 4000, stepRewardCap: 400 });
	});
});

describe('mastery: quest ID helpers', () => {
	it('round-trips badge id <-> quest id', () => {
		const id = masteryQuestId('article_enthusiast');
		expect(id).toBe(`${MASTERY_QUEST_ID_PREFIX}article_enthusiast`);
		expect(masteryBadgeIdFromQuestId(id)).toBe('article_enthusiast');
	});

	it('returns null for non-mastery quest IDs', () => {
		expect(masteryBadgeIdFromQuestId('vegetable_head')).toBeNull();
		expect(masteryBadgeIdFromQuestId('activity_quest_gardening')).toBeNull();
		expect(masteryBadgeIdFromQuestId('badge_mastery_')).toBeNull();
	});
});

describe('mastery: labelsForBadge', () => {
	it('returns tracker-specific labels when available', () => {
		const labels = labelsForBadge(exampleBadge);
		expect(labels).toContain('book_jacket');
	});

	it('falls back to default labels when badge has no known tracker', () => {
		const fakeBadge = {
			id: 'fake',
			name: 'Fake',
			description: '',
			icon: '',
			rarity: 'normal' as Rarity
		};
		const labels = labelsForBadge(fakeBadge);
		expect(labels.length).toBeGreaterThan(0);
		expect(labels).toContain('envelope');
	});
});

describe('mastery: KV state helpers', () => {
	it('returns null/false for empty KV state', async () => {
		const kv = new MockKVNamespace();
		expect(await getMasteryQuest('1', 'article_enthusiast', kv as any)).toBeNull();
		expect(await isMasteryLocked('1', 'article_enthusiast', kv as any)).toBe(false);
		expect(await isBadgeMastered('1', 'article_enthusiast', kv as any)).toBe(false);
		expect(await getMasteredMetadata('1', 'article_enthusiast', kv as any)).toBeNull();
	});

	it('markBadgeMastered persists mastered_at and isBadgeMastered reflects it', async () => {
		const kv = new MockKVNamespace();
		await markBadgeMastered('1', 'article_enthusiast', kv as any);

		expect(await isBadgeMastered('1', 'article_enthusiast', kv as any)).toBe(true);
		const meta = await getMasteredMetadata('1', 'article_enthusiast', kv as any);
		expect(meta?.mastered_at).toEqual(expect.any(Number));
	});

	it('lockMasteryQuest writes a marker and deletes the stored quest', async () => {
		const kv = new MockKVNamespace();
		// Pre-seed a stored quest
		await kv.put(
			'user:badge_mastery:1:article_enthusiast',
			JSON.stringify({ quest: { id: 'x' }, generated_at: 1 })
		);
		expect(await isMasteryLocked('1', 'article_enthusiast', kv as any)).toBe(false);

		await lockMasteryQuest('1', 'article_enthusiast', kv as any);

		expect(await isMasteryLocked('1', 'article_enthusiast', kv as any)).toBe(true);
		expect(await getMasteryQuest('1', 'article_enthusiast', kv as any)).toBeNull();
	});
});

describe('mastery: lockActiveMasteryIfApplicable', () => {
	it('locks when the active quest is a known mastery quest', async () => {
		const kv = new MockKVNamespace();
		const result = await lockActiveMasteryIfApplicable(
			'1',
			masteryQuestId(exampleBadge.id),
			kv as any
		);
		expect(result.locked).toBe(true);
		expect(result.badgeId).toBe(exampleBadge.id);
		expect(await isMasteryLocked('1', exampleBadge.id, kv as any)).toBe(true);
	});

	it('does nothing for non-mastery quest IDs', async () => {
		const kv = new MockKVNamespace();
		const result = await lockActiveMasteryIfApplicable('1', 'vegetable_head', kv as any);
		expect(result.locked).toBe(false);
		expect(result.badgeId).toBeNull();
	});

	it('ignores mastery quest IDs whose badge does not exist in the catalog', async () => {
		const kv = new MockKVNamespace();
		const result = await lockActiveMasteryIfApplicable(
			'1',
			`${MASTERY_QUEST_ID_PREFIX}unknown_badge`,
			kv as any
		);
		expect(result.locked).toBe(false);
		expect(result.badgeId).toBeNull();
	});

	it('returns false when activeQuestId is null/undefined', async () => {
		const kv = new MockKVNamespace();
		expect((await lockActiveMasteryIfApplicable('1', null, kv as any)).locked).toBe(false);
		expect((await lockActiveMasteryIfApplicable('1', undefined, kv as any)).locked).toBe(false);
	});
});

describe('mastery: validateBadgeMasterySteps clamping', () => {
	it('throws when too few valid steps survive clamping', () => {
		expect(() => validateBadgeMasterySteps({ steps: [] }, ctxFor('normal'))).toThrow(
			/produced 0 valid steps/
		);
	});

	it('throws when payload is not an object or missing steps', () => {
		expect(() => validateBadgeMasterySteps(null, ctxFor('normal'))).toThrow();
		expect(() => validateBadgeMasterySteps({ items: [] }, ctxFor('normal'))).toThrow(
			/missing a `steps` array/
		);
	});

	it('drops unknown step types and unrecognised labels/activity types', () => {
		const raw = {
			steps: [
				{ type: 'totally_fake_type', description: 'invalid step' },
				{ type: 'article_quiz', description: 'Quiz', activity_type: 'NOT_REAL', threshold: 0.7 },
				{
					type: 'take_photo_classification',
					description: 'Photo',
					label: 'submarine',
					threshold: 0.6
				},
				{ type: 'draw_picture', description: 'Draw a leaf', prompt: 'leaf', threshold: 0.6 },
				{ type: 'draw_picture', description: 'Draw a sun', prompt: 'sun', threshold: 0.6 },
				{ type: 'draw_picture', description: 'Draw a star', prompt: 'star', threshold: 0.6 },
				{ type: 'draw_picture', description: 'Draw a fern', prompt: 'fern', threshold: 0.6 }
			]
		};

		const clamped = validateBadgeMasterySteps(raw, ctxFor('normal'));
		expect(clamped).toHaveLength(4);
		expect(clamped.every((s) => s.type === 'draw_picture')).toBe(true);
	});

	it('clamps thresholds and rewards into safe ranges', () => {
		const raw = {
			steps: Array.from({ length: 4 }, (_, idx) => ({
				type: 'article_quiz',
				description: `Quiz ${idx}`,
				activity_type: 'HOBBY',
				threshold: 5, // wildly out of range
				reward: 5000 // way above cap
			}))
		};

		const clamped = validateBadgeMasterySteps(raw, ctxFor('normal'));
		expect(clamped).toHaveLength(4);
		for (const step of clamped) {
			expect(step.type).toBe('article_quiz');
			expect(step.reward).toBeLessThanOrEqual(125); // normal cap
			if (step.type === 'article_quiz') {
				const [, threshold] = step.parameters;
				expect(threshold).toBeLessThanOrEqual(1.0);
				expect(threshold).toBeGreaterThanOrEqual(0.6);
			}
		}
	});

	it('injects 24h delay on the second half of steps', () => {
		const raw = {
			steps: Array.from({ length: 4 }, (_, idx) => ({
				type: 'article_quiz',
				description: `Quiz ${idx}`,
				activity_type: 'LEARNING',
				threshold: 0.8
			}))
		};

		const clamped = validateBadgeMasterySteps(raw, ctxFor('normal'));
		expect(clamped).toHaveLength(4);
		// cutover = ceil(4/2) = 2 → indices 2,3 should have delay; 0,1 should not.
		expect(clamped[0].delay).toBeUndefined();
		expect(clamped[1].delay).toBeUndefined();
		expect(clamped[2].delay).toBe(24 * 60 * 60);
		expect(clamped[3].delay).toBe(24 * 60 * 60);
	});

	it('converts minutes → seconds for read-time steps and wraps activity_read_time params', () => {
		const raw = {
			steps: [
				{
					type: 'article_read_time',
					description: 'Read',
					activity_type: 'LEARNING',
					minutes: 10
				},
				{ type: 'activity_read_time', description: 'Read', activity_type: 'HOBBY', minutes: 8 },
				{
					type: 'article_read_time',
					description: 'Read',
					activity_type: 'STUDY',
					minutes: 999 // clamps to 30
				},
				{
					type: 'article_read_time',
					description: 'Read',
					activity_type: 'HOBBY',
					minutes: 1 // clamps to 5
				}
			]
		};

		const clamped = validateBadgeMasterySteps(raw, ctxFor('normal'));
		const article = clamped[0];
		expect(article.type).toBe('article_read_time');
		if (article.type === 'article_read_time') {
			expect(article.parameters[0]).toBe('LEARNING');
			expect(article.parameters[1]).toBe(10 * 60);
		}

		const activity = clamped[1];
		expect(activity.type).toBe('activity_read_time');
		if (activity.type === 'activity_read_time') {
			expect(activity.parameters[0]).toEqual({ type: 'activity_type', value: 'HOBBY' });
			expect(activity.parameters[1]).toBe(8 * 60);
		}

		// 999 clamps to 30 minutes
		const capped = clamped[2];
		if (capped.type === 'article_read_time') {
			expect(capped.parameters[1]).toBe(30 * 60);
		}

		// 1 clamps to 5 minutes
		const floored = clamped[3];
		if (floored.type === 'article_read_time') {
			expect(floored.parameters[1]).toBe(5 * 60);
		}
	});

	it('rejects match_terms/order_items with fewer than 4 entries', () => {
		const raw = {
			steps: [
				// invalid - only 2 pairs
				{
					type: 'match_terms',
					description: 'Match',
					prompt: 'pair them',
					pairs: [
						['a', 'A'],
						['b', 'B']
					]
				},
				// invalid - only 3 items
				{ type: 'order_items', description: 'Order', items: ['a', 'b', 'c'] },
				// 4 valid drawings to keep step count
				...Array.from({ length: 4 }, (_, idx) => ({
					type: 'draw_picture',
					description: `Draw ${idx}`,
					prompt: 'subject',
					threshold: 0.6
				}))
			]
		};
		const clamped = validateBadgeMasterySteps(raw, ctxFor('normal'));
		expect(clamped).toHaveLength(4);
		expect(clamped.every((s) => s.type === 'draw_picture')).toBe(true);
	});

	it('builds describe_text criteria server-side (AI cannot inject custom criteria)', () => {
		const raw = {
			steps: Array.from({ length: 4 }, (_, idx) => ({
				type: 'describe_text',
				description: `Reflect ${idx}`,
				prompt: 'Tell us something',
				threshold: 0.6,
				min_length: 100,
				// AI-emitted criteria should be ignored
				criteria: [{ id: 'evil', weight: 99, ideal: 'reject me' }]
			}))
		};
		const clamped = validateBadgeMasterySteps(raw, ctxFor('normal'));
		for (const step of clamped) {
			if (step.type === 'describe_text') {
				const [criteria] = step.parameters;
				expect(criteria.map((c) => c.id).sort()).toEqual(['depth', 'originality', 'relevance']);
				const totalWeight = criteria.reduce((a, c) => a + c.weight, 0);
				expect(totalWeight).toBeCloseTo(1.0, 2);
			}
		}
	});
});

describe('mastery: badgeMasteryAiSchema', () => {
	it('produces a schema with the requested step count as both min/max', () => {
		const schema = badgeMasteryAiSchema(6);
		expect((schema.properties.steps as any).minItems).toBe(6);
		expect((schema.properties.steps as any).maxItems).toBe(6);
	});
});
