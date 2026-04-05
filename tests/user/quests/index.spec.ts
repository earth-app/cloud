import { describe, expect, it } from 'vitest';
import { quests } from '../../../src/user/quests';

describe('quests', () => {
	it('exports a non-empty list of quests', () => {
		expect(Array.isArray(quests)).toBe(true);
		expect(quests.length).toBeGreaterThan(0);
	});

	it('includes required top-level fields on every quest', () => {
		for (const quest of quests) {
			expect(typeof quest.id).toBe('string');
			expect(typeof quest.title).toBe('string');
			expect(typeof quest.description).toBe('string');
			expect(typeof quest.icon).toBe('string');
			expect(Array.isArray(quest.steps)).toBe(true);
			expect(quest.steps.length).toBeGreaterThan(0);
			expect(typeof quest.reward).toBe('number');
		}
	});

	it('uses only valid rarity values', () => {
		const valid = new Set(['normal', 'rare', 'amazing', 'green']);
		expect(quests.every((quest) => valid.has(quest.rarity))).toBe(true);
	});

	it('ensures each quest step has a type and description', () => {
		for (const quest of quests) {
			for (const stepGroup of quest.steps) {
				if (Array.isArray(stepGroup)) {
					expect(stepGroup.length).toBeGreaterThan(0);
					for (const step of stepGroup) {
						expect(typeof step.type).toBe('string');
						expect(typeof step.description).toBe('string');
					}
				} else {
					expect(typeof stepGroup.type).toBe('string');
					expect(typeof stepGroup.description).toBe('string');
				}
			}
		}
	});
});
