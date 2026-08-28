/**
 * Guards the copy this worker authors against claims the behaviour-design evidence does not
 * support. Each pattern records why it cannot be written down.
 *
 * Scanned by importing the catalogs rather than reading files: the pool runs in workerd and has no
 * real filesystem, and the imported values are the copy that actually ships.
 */

import { describe, expect, it } from 'vitest';
import { quests } from '../src/user/quests/index';
import { badges } from '../src/user/badges/index';
import * as ai from '../src/util/ai';
import * as trails from '../src/user/trails';

const BANNED: { pattern: RegExp; why: string }[] = [
	{
		pattern: /\baddict(ion|ive|ed|s)\b/i,
		why: 'behavioural addiction is a contested construct, not a DSM-5/ICD-11 diagnosis'
	},
	{
		pattern:
			/within\s+300\s*m(eters?|etres?)?\b|300\s*m(eters?|etres?)?\s+of\s+(green|a park|nature)/i,
		why: 'the 300 m green-space threshold is a planning convention with no behavioural derivation'
	},
	{
		pattern: /120\s*min(ute)?s?\s*(a|per|\/)\s*week|two hours a week (outside|outdoors|in nature)/i,
		why: 'White 2019 is cross-sectional and its authors declined to turn 120 min/week into guidance'
	},
	{
		pattern: /the amount linked to|the dose linked to/i,
		why: 'reads as a prescribed dose; there is no established one'
	},
	{
		pattern: /(reduces|cures|prevents|treats)\s+(stress|anxiety|loneliness|depression)/i,
		why: 'no causal claim is available; more contact does not even reduce loneliness (Masi 2011)'
	},
	{
		pattern: /(scientifically|clinically)\s+proven|proven\s+to\s+(reduce|improve|boost)/i,
		why: 'nothing in this evidence base is at proof strength'
	},
	{
		pattern: /verif(y|ies|ied)\s+(you|your|that you)\s+(were|are|went)/i,
		why: 'nature minutes are self-reported time outside, never verified presence'
	}
];

// every string reachable from the module's exported values, including prompt builders called with
// a placeholder so their template text is covered too
function stringsFrom(source: Record<string, unknown>): string[] {
	const out: string[] = [];

	const walk = (value: unknown, depth: number) => {
		if (depth > 8) return;
		if (typeof value === 'string') {
			out.push(value);
			return;
		}
		if (Array.isArray(value)) {
			for (const item of value) walk(item, depth + 1);
			return;
		}
		if (value && typeof value === 'object') {
			for (const item of Object.values(value)) walk(item, depth + 1);
		}
	};

	for (const value of Object.values(source)) {
		if (typeof value === 'function') {
			// arity-1 builders take an activity/topic name; anything else is skipped rather than
			// invoked with a guessed shape
			if (value.length !== 1) continue;
			try {
				walk((value as (arg: string) => unknown)('walking'), 0);
			} catch {
				// a builder that rejects the placeholder contributes nothing to scan
			}
			continue;
		}
		walk(value, 0);
	}

	return out;
}

const CORPUS = [
	...stringsFrom({ quests }),
	...stringsFrom({ badges }),
	...stringsFrom(ai as unknown as Record<string, unknown>),
	...stringsFrom(trails as unknown as Record<string, unknown>)
];

describe('authored copy guards', () => {
	it('has a corpus to scan', () => {
		expect(CORPUS.length).toBeGreaterThan(500);
	});

	for (const { pattern, why } of BANNED) {
		it(`never says ${pattern.source.slice(0, 42)} (${why})`, () => {
			const offenders = CORPUS.filter((text) => pattern.test(text)).map((text) =>
				text.slice(0, 120)
			);
			expect(offenders).toEqual([]);
		});
	}

	it('the scan would actually catch a violation', () => {
		const banned = BANNED.find((entry) => entry.pattern.test('aim for 120 minutes a week'));
		expect(banned).toBeDefined();
	});
});
