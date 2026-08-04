import { describe, expect, it } from 'vitest';
import {
	isRecommendActivity,
	parseActivities,
	recommendActivity,
	type RecommendActivity
} from '../../src/content/recommend';

/*
 * Ported from ocean's `com.earthapp.ocean.recommendActivity`. These pin the scoring so the kotlin
 * behaviour mantle2 depends on cannot drift: same tokenizer, same 0.6/0.4 weighting, same
 * three-slot selection.
 */

function activity(
	id: string,
	name: string,
	description: string,
	types: string[] = ['HOBBY']
): RecommendActivity {
	return { id, name, description, activity_types: types as RecommendActivity['activity_types'] };
}

describe('validation', () => {
	it('accepts a well-formed activity', () => {
		expect(isRecommendActivity(activity('a', 'Running', 'Going for a run'))).toBe(true);
	});

	it('rejects entries the algorithm could not score', () => {
		expect(isRecommendActivity(null)).toBe(false);
		expect(isRecommendActivity({})).toBe(false);
		expect(isRecommendActivity({ id: '', name: 'x' })).toBe(false);
		expect(isRecommendActivity({ id: 'a', name: '' })).toBe(false);
		expect(isRecommendActivity({ id: 'a', name: 'x', description: 5 })).toBe(false);
	});

	/* ocean ran these through Exportable.fromJson, which THREW on a malformed entry and took the
	   whole request with it; dropping the bad row keeps a recommendation coming back */
	it('drops bad entries instead of failing the batch', () => {
		const parsed = parseActivities([
			activity('a', 'Running', 'Going for a run'),
			{ id: '', name: 'broken' },
			activity('b', 'Cycling', 'Riding a bike')
		]);
		expect(parsed.map((a) => a.id)).toEqual(['a', 'b']);
	});

	it('treats a non-array as empty', () => {
		expect(parseActivities(null)).toEqual([]);
		expect(parseActivities({})).toEqual([]);
	});
});

describe('recommendActivity', () => {
	it('never recommends something the user already does', () => {
		const user = [activity('a', 'Running', 'Going for a run outdoors')];
		const all = [user[0]!, activity('b', 'Jogging', 'Going for a run outdoors slowly')];

		const out = recommendActivity(all, user);

		expect(out.map((a) => a.id)).not.toContain('a');
	});

	it('ranks the closest keyword match first', () => {
		const user = [activity('u', 'Trail Running', 'running outdoors on forest trails')];
		const all = [
			activity('far', 'Accounting', 'balancing ledgers and spreadsheets', ['FINANCE']),
			activity('near', 'Forest Running', 'running outdoors on trails through the forest'),
			activity('mid', 'Cycling', 'riding outdoors on roads')
		];

		const out = recommendActivity(all, user);

		expect(out[0]?.id).toBe('near');
	});

	it('returns at most three', () => {
		const user = [activity('u', 'Running', 'running outdoors')];
		const all = Array.from({ length: 20 }, (_, i) =>
			activity(`a${i}`, `Activity ${i}`, `description number ${i}`)
		);

		expect(recommendActivity(all, user)).toHaveLength(3);
	});

	it('handles a single candidate without inventing entries', () => {
		const user = [activity('u', 'Running', 'running outdoors')];
		const all = [activity('only', 'Cycling', 'riding a bike')];

		const out = recommendActivity(all, user);

		// first and `different` both resolve to the one candidate; app.ts dedupes by id
		expect(out.every((a) => a.id === 'only')).toBe(true);
	});

	it('returns nothing when every candidate is already taken', () => {
		const user = [activity('a', 'Running', 'running outdoors')];
		expect(recommendActivity([user[0]!], user)).toEqual([]);
	});

	// the tokenizer drops tokens of length <= 2, so short words must not create similarity
	it('ignores tokens of two characters or fewer', () => {
		const user = [activity('u', 'go to it', 'an ok us go')];
		const all = [activity('c', 'go to it', 'an ok us go')];

		const out = recommendActivity(all, user);

		expect(out[0]?.id).toBe('c');
	});

	it('scores shared activity types even with no shared words', () => {
		const user = [activity('u', 'Painting', 'acrylic canvases', ['ART'])];
		const all = [
			activity('typed', 'Sculpting', 'clay figures', ['ART']),
			activity('untyped', 'Bookkeeping', 'ledgers', ['FINANCE'])
		];

		const out = recommendActivity(all, user);

		expect(out[0]?.id).toBe('typed');
	});

	it('tolerates missing descriptions and types', () => {
		const user = [{ id: 'u', name: 'Running' }];
		const all = [{ id: 'c', name: 'Cycling' }];

		expect(() => recommendActivity(all, user)).not.toThrow();
	});
});
