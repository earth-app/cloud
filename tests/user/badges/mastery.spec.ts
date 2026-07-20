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
import type { QuestStep } from '../../../src/user/quests';

const exampleBadge = badges.find((b) => b.id === 'article_enthusiast')!;

// Narrowing helpers for the (QuestStep | QuestStep[])[] return type.
// Non-mobile clamped entries are always single steps; mobile-only entries are alt arrays of [mobile, describe_text fallback].
function asSingle(entry: QuestStep | QuestStep[]): QuestStep {
	if (Array.isArray(entry)) throw new Error('Expected single step, got alt-array');
	return entry;
}
function asAlt(entry: QuestStep | QuestStep[]): QuestStep[] {
	if (!Array.isArray(entry)) throw new Error('Expected alt-array, got single step');
	return entry;
}

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
		minAltGroups: spec.minAltGroups,
		maxAltsPerGroup: spec.maxAltsPerGroup,
		allowedLabels: ['book_jacket', 'envelope'],
		allowedActivityTypes: ['HOBBY', 'LEARNING', 'STUDY'] as ActivityType[],
		...overrides
	};
}

describe('mastery: spec table', () => {
	it('returns correct step count, reward, and alt-group caps per rarity', () => {
		expect(masterySpec('normal')).toEqual({
			stepCount: 4,
			reward: 500,
			stepRewardCap: 125,
			minAltGroups: 1,
			maxAltsPerGroup: 3
		});
		expect(masterySpec('rare')).toEqual({
			stepCount: 5,
			reward: 800,
			stepRewardCap: 160,
			minAltGroups: 1,
			maxAltsPerGroup: 3
		});
		expect(masterySpec('amazing')).toEqual({
			stepCount: 6,
			reward: 1500,
			stepRewardCap: 250,
			minAltGroups: 2,
			maxAltsPerGroup: 4
		});
		expect(masterySpec('green')).toEqual({
			stepCount: 7,
			reward: 2500,
			stepRewardCap: 357,
			minAltGroups: 3,
			maxAltsPerGroup: 5
		});
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
		expect(clamped.map(asSingle).every((s) => s.type === 'draw_picture')).toBe(true);
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
		for (const entry of clamped) {
			const step = asSingle(entry);
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
		expect(asSingle(clamped[0]).delay).toBeUndefined();
		expect(asSingle(clamped[1]).delay).toBeUndefined();
		expect(asSingle(clamped[2]).delay).toBe(24 * 60 * 60);
		expect(asSingle(clamped[3]).delay).toBe(24 * 60 * 60);
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
		const article = asSingle(clamped[0]);
		expect(article.type).toBe('article_read_time');
		if (article.type === 'article_read_time') {
			expect(article.parameters[0]).toBe('LEARNING');
			expect(article.parameters[1]).toBe(10 * 60);
		}

		const activity = asSingle(clamped[1]);
		expect(activity.type).toBe('activity_read_time');
		if (activity.type === 'activity_read_time') {
			expect(activity.parameters[0]).toEqual({ type: 'activity_type', value: 'HOBBY' });
			expect(activity.parameters[1]).toBe(8 * 60);
		}

		// 999 clamps to 30 minutes
		const capped = asSingle(clamped[2]);
		if (capped.type === 'article_read_time') {
			expect(capped.parameters[1]).toBe(30 * 60);
		}

		// 1 clamps to 5 minutes
		const floored = asSingle(clamped[3]);
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
		expect(clamped.map(asSingle).every((s) => s.type === 'draw_picture')).toBe(true);
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
		for (const entry of clamped) {
			const step = asSingle(entry);
			if (step.type === 'describe_text') {
				const [criteria] = step.parameters;
				expect(criteria.map((c) => c.id).sort()).toEqual(['depth', 'originality', 'relevance']);
				const totalWeight = criteria.reduce((a, c) => a + c.weight, 0);
				expect(totalWeight).toBeCloseTo(1.0, 2);
			}
		}
	});

	it('can generate nature_minutes and trailmarker_added steps', () => {
		const raw = {
			steps: [
				{ type: 'draw_picture', description: 'Draw a leaf', prompt: 'leaf', threshold: 0.6 },
				{ type: 'nature_minutes', description: 'Spend time outside', minutes: 15 },
				{ type: 'trailmarker_added', description: 'Leave a note', keyword: 'trail' },
				{ type: 'trailmarker_added', description: 'Leave any note' }
			]
		};
		const clamped = validateBadgeMasterySteps(raw, ctxFor('normal'));
		expect(clamped).toHaveLength(4);

		const types = clamped.map((e) => (Array.isArray(e) ? e[0].type : e.type));
		expect(types).toContain('nature_minutes');
		expect(types).toContain('trailmarker_added');

		const nature = clamped.map(asSingle).find((s) => s.type === 'nature_minutes');
		expect(nature).toBeDefined();
		if (nature && nature.type === 'nature_minutes') {
			expect(nature.parameters[0]).toBe(15);
		}

		// keyword survives when it is a single lowercase token
		const tmKeyword = clamped
			.map(asSingle)
			.find((s) => s.type === 'trailmarker_added' && s.parameters.length === 1);
		if (tmKeyword && tmKeyword.type === 'trailmarker_added') {
			expect(tmKeyword.parameters[0]).toBe('trail');
		}

		// a param-less trailmarker_added step is valid (any note qualifies)
		const tmBare = clamped
			.map(asSingle)
			.find((s) => s.type === 'trailmarker_added' && s.parameters.length === 0);
		expect(tmBare).toBeDefined();
	});
});

describe('mastery: mobile-only step wrapping', () => {
	it('wraps distance_covered with a describe_text fallback alt', () => {
		const raw = {
			steps: [
				{
					type: 'distance_covered',
					description: 'Walk a route through your neighborhood.',
					meters: 800
				},
				...Array.from({ length: 3 }, (_, idx) => ({
					type: 'draw_picture',
					description: `Draw ${idx}`,
					prompt: 'leaf',
					threshold: 0.6
				}))
			]
		};

		const clamped = validateBadgeMasterySteps(raw, ctxFor('normal'));
		expect(clamped).toHaveLength(4);
		const alt = asAlt(clamped[0]);
		expect(alt).toHaveLength(2);
		expect(alt[0].type).toBe('distance_covered');
		if (alt[0].type === 'distance_covered') {
			expect(alt[0].parameters[0]).toBe(800);
			expect(alt[0].mobile_only).toBe(true);
		}
		expect(alt[1].type).toBe('describe_text');
	});

	it('wraps scan_barcode with a describe_text fallback alt and preserves optional keyword', () => {
		const raw = {
			steps: [
				{
					type: 'scan_barcode',
					description: 'Scan a book that connects to your reading habits.',
					scan_kind: 'book',
					scan_keyword: 'science'
				},
				...Array.from({ length: 3 }, (_, idx) => ({
					type: 'draw_picture',
					description: `Draw ${idx}`,
					prompt: 'leaf',
					threshold: 0.6
				}))
			]
		};

		const clamped = validateBadgeMasterySteps(raw, ctxFor('normal'));
		const alt = asAlt(clamped[0]);
		expect(alt).toHaveLength(2);
		expect(alt[0].type).toBe('scan_barcode');
		if (alt[0].type === 'scan_barcode') {
			expect(alt[0].parameters).toEqual(['book', 'science']);
			expect(alt[0].mobile_only).toBe(true);
		}
		expect(alt[1].type).toBe('describe_text');
	});

	it('drops scan_barcode with invalid kind; strips malformed keywords but keeps the step kind-only', () => {
		const raw = {
			steps: [
				// invalid kind — whole step dropped
				{ type: 'scan_barcode', description: 'x', scan_kind: 'tool' },
				// valid kind, multi-word keyword — keyword stripped, kind-only scan kept
				{
					type: 'scan_barcode',
					description: 'Scan a food item.',
					scan_kind: 'food',
					scan_keyword: 'hot dog'
				},
				// 3 valid drawings to fill the rest
				...Array.from({ length: 3 }, (_, idx) => ({
					type: 'draw_picture',
					description: `Draw ${idx}`,
					prompt: 'subject',
					threshold: 0.6
				}))
			]
		};
		const clamped = validateBadgeMasterySteps(raw, ctxFor('normal'));
		expect(clamped).toHaveLength(4);

		// The surviving scan_barcode lives in an alt-array; keyword should have been stripped.
		const altEntries = clamped.filter((e): e is QuestStep[] => Array.isArray(e));
		expect(altEntries).toHaveLength(1);
		const mobileStep = altEntries[0][0];
		expect(mobileStep.type).toBe('scan_barcode');
		if (mobileStep.type === 'scan_barcode') {
			expect(mobileStep.parameters).toEqual(['food']); // no second arg
		}
	});

	it('clamps distance_covered meters into [200, 5000]', () => {
		const raw = {
			steps: [
				{ type: 'distance_covered', description: 'tiny', meters: 50 },
				{ type: 'distance_covered', description: 'huge', meters: 50_000 }, // dup mobile type — dropped
				...Array.from({ length: 3 }, () => ({
					type: 'draw_picture',
					description: 'Draw a leaf',
					prompt: 'leaf',
					threshold: 0.6
				}))
			]
		};
		const clamped = validateBadgeMasterySteps(raw, ctxFor('normal'));
		expect(clamped).toHaveLength(4);
		// Only ONE distance_covered survives per quest. Second is dropped via the mobile-type-seen cap.
		const distanceEntries = clamped.filter(
			(e): e is QuestStep[] => Array.isArray(e) && e.some((s) => s.type === 'distance_covered')
		);
		expect(distanceEntries).toHaveLength(1);
		const dStep = distanceEntries[0][0];
		if (dStep.type === 'distance_covered') {
			expect(dStep.parameters[0]).toBeGreaterThanOrEqual(200);
			expect(dStep.parameters[0]).toBeLessThanOrEqual(5000);
		}
	});

	it('caps total mobile-only steps per quest (at most one of each + global cap)', () => {
		const raw = {
			steps: [
				{ type: 'distance_covered', description: 'walk', meters: 1000 },
				{ type: 'distance_covered', description: 'walk again', meters: 1500 }, // dropped (dup type)
				{ type: 'scan_barcode', description: 'scan', scan_kind: 'book' },
				{ type: 'scan_barcode', description: 'scan more', scan_kind: 'food' }, // dropped (dup type)
				...Array.from({ length: 4 }, (_, idx) => ({
					type: 'draw_picture',
					description: `Draw ${idx}`,
					prompt: 'subject',
					threshold: 0.6
				}))
			]
		};
		const clamped = validateBadgeMasterySteps(raw, ctxFor('normal'));
		const mobileEntries = clamped.filter(Array.isArray);
		// One distance_covered alt + one scan_barcode alt = 2 alts max.
		expect(mobileEntries).toHaveLength(2);
	});

	it('applies the 24h delay to BOTH branches of an alt-wrapped step in the second half', () => {
		// 4 steps total; mobile-only at index 3 (in the delayed half) should have delay on both alts.
		const raw = {
			steps: [
				...Array.from({ length: 3 }, (_, idx) => ({
					type: 'draw_picture',
					description: `Draw ${idx}`,
					prompt: 'leaf',
					threshold: 0.6
				})),
				{ type: 'distance_covered', description: 'walk', meters: 1000 }
			]
		};
		const clamped = validateBadgeMasterySteps(raw, ctxFor('normal'));
		const tail = asAlt(clamped[3]);
		expect(tail[0].delay).toBe(24 * 60 * 60);
		expect(tail[1].delay).toBe(24 * 60 * 60);
	});

	it('tier-aware default for distance_covered scales with tierIndex', () => {
		const ctxLow = ctxFor('normal', {
			tier: {
				tierIndex: 0,
				totalTiers: 4,
				easier: [],
				harder: [{ name: 'Super', description: 'harder' }]
			}
		});
		const ctxHigh = ctxFor('normal', {
			tier: {
				tierIndex: 3,
				totalTiers: 4,
				easier: [{ name: 'Base', description: 'easier' }],
				harder: []
			}
		});
		const raw = {
			steps: [
				// `meters` omitted — clamp uses the tier-aware default.
				{ type: 'distance_covered', description: 'walk' },
				...Array.from({ length: 3 }, () => ({
					type: 'draw_picture',
					description: 'Draw',
					prompt: 'leaf',
					threshold: 0.6
				}))
			]
		};
		const low = validateBadgeMasterySteps(raw, ctxLow);
		const high = validateBadgeMasterySteps(raw, ctxHigh);
		const lowStep = asAlt(low[0])[0];
		const highStep = asAlt(high[0])[0];
		if (lowStep.type === 'distance_covered' && highStep.type === 'distance_covered') {
			expect(highStep.parameters[0]).toBeGreaterThan(lowStep.parameters[0]);
		}
	});
});

describe('mastery: badgeMasteryAiSchema', () => {
	it('produces a schema with the requested step count as both min/max', () => {
		const schema = badgeMasteryAiSchema(6);
		expect((schema.properties.steps as any).minItems).toBe(6);
		expect((schema.properties.steps as any).maxItems).toBe(6);
	});

	it('attaches an alternates array with the per-rarity cap', () => {
		const schema = badgeMasteryAiSchema(6, 4);
		const stepItem = (schema.properties.steps as any).items;
		expect(stepItem.properties.alternates).toBeDefined();
		expect(stepItem.properties.alternates.maxItems).toBe(4);
		// alternates entries must not nest more alternates (clamper would ignore them anyway)
		expect(stepItem.properties.alternates.items.properties.alternates).toBeUndefined();
	});
});

describe('mastery: loose clamping recovery', () => {
	it('promotes alternates into primary slots when too few primaries clamp cleanly', () => {
		// only 1 valid primary; 4 alts attached. clamper should promote 3 of them to fill stepCount=4
		const raw = {
			steps: [
				{
					type: 'draw_picture',
					description: 'Draw a leaf',
					prompt: 'leaf',
					threshold: 0.6,
					alternates: [
						{
							type: 'article_quiz',
							description: 'Quiz 1',
							activity_type: 'HOBBY',
							threshold: 0.8
						},
						{
							type: 'article_quiz',
							description: 'Quiz 2',
							activity_type: 'LEARNING',
							threshold: 0.8
						},
						{
							type: 'article_quiz',
							description: 'Quiz 3',
							activity_type: 'STUDY',
							threshold: 0.8
						},
						{
							type: 'draw_picture',
							description: 'Draw a fern',
							prompt: 'fern',
							threshold: 0.6
						}
					]
				},
				// these primaries are invalid (no activity_type match) but their alts will be salvaged
				{ type: 'article_quiz', description: 'invalid', activity_type: 'NOPE', threshold: 0.8 }
			]
		};
		const clamped = validateBadgeMasterySteps(raw, ctxFor('normal'));
		expect(clamped).toHaveLength(4);
	});

	it('strips alternates off the first step (singularized) and redistributes to a middle step', () => {
		const raw = {
			steps: [
				{
					type: 'draw_picture',
					description: 'first',
					prompt: 'sun',
					threshold: 0.6,
					alternates: [
						{ type: 'draw_picture', description: 'alt for first', prompt: 'star', threshold: 0.6 }
					]
				},
				{ type: 'draw_picture', description: 'mid 1', prompt: 'tree', threshold: 0.6 },
				{ type: 'draw_picture', description: 'mid 2', prompt: 'fish', threshold: 0.6 },
				{ type: 'draw_picture', description: 'last', prompt: 'wave', threshold: 0.6 }
			]
		};
		const clamped = validateBadgeMasterySteps(raw, ctxFor('normal'));
		expect(clamped).toHaveLength(4);
		// first + last must be singular
		expect(Array.isArray(clamped[0])).toBe(false);
		expect(Array.isArray(clamped[3])).toBe(false);
		// the displaced alt should have landed on a middle step
		const middleAlts = [clamped[1], clamped[2]].filter(Array.isArray);
		expect(middleAlts.length).toBeGreaterThan(0);
	});

	it('drops excess primaries past stepCount instead of throwing', () => {
		const raw = {
			steps: Array.from({ length: 8 }, (_, idx) => ({
				type: 'draw_picture',
				description: `Draw ${idx}`,
				prompt: 'leaf',
				threshold: 0.6
			}))
		};
		const clamped = validateBadgeMasterySteps(raw, ctxFor('normal'));
		expect(clamped).toHaveLength(4);
	});

	it('does not synthesize alts when the ai emits none (no fabrication)', () => {
		const raw = {
			steps: Array.from({ length: 4 }, (_, idx) => ({
				type: 'draw_picture',
				description: `Draw ${idx}`,
				prompt: 'leaf',
				threshold: 0.6
			}))
		};
		const clamped = validateBadgeMasterySteps(raw, ctxFor('normal'));
		expect(clamped).toHaveLength(4);
		// every entry should be a single step (no alt arrays without ai-emitted alts)
		expect(clamped.every((e) => !Array.isArray(e))).toBe(true);
	});

	it('caps alt-group size at maxAltsPerGroup', () => {
		// inject one primary with 10 alts; clamper should keep at most 3 (normal cap)
		const raw = {
			steps: [
				{ type: 'draw_picture', description: 'first', prompt: 'sun', threshold: 0.6 },
				{
					type: 'draw_picture',
					description: 'mid with many alts',
					prompt: 'tree',
					threshold: 0.6,
					alternates: Array.from({ length: 10 }, (_, idx) => ({
						type: 'draw_picture',
						description: `alt ${idx}`,
						prompt: 'fern',
						threshold: 0.6
					}))
				},
				{ type: 'draw_picture', description: 'mid 2', prompt: 'fish', threshold: 0.6 },
				{ type: 'draw_picture', description: 'last', prompt: 'wave', threshold: 0.6 }
			]
		};
		const clamped = validateBadgeMasterySteps(raw, ctxFor('normal'));
		expect(clamped).toHaveLength(4);
		const midEntry = clamped[1];
		expect(Array.isArray(midEntry)).toBe(true);
		// group size = primary + alts; normal cap is 3 alts, so total <= 4 variants
		expect((midEntry as QuestStep[]).length).toBeLessThanOrEqual(4);
	});
});
