import { describe, expect, it } from 'vitest';
import { quests } from '../../../src/user/quests';
import ocean from '@earth-app/ocean';

function normalizeVisionLabel(label: string): string {
	return label.trim().toLowerCase().replace(/\s+/g, '_');
}

const validActivityTypes = new Set(
	ocean.com.earthapp.activity.ActivityType.values().map((value) => value.name)
);

describe('quests', () => {
	it('exports a non-empty list of quests', () => {
		expect(Array.isArray(quests)).toBe(true);
		expect(quests.length).toBeGreaterThan(0);
	});

	it('includes required top-level fields on every quest', () => {
		for (const quest of quests) {
			expect(typeof quest.id, `Quest ID in '${quest.id}' is not a string`).toBe('string');
			expect(typeof quest.title, `Quest title in '${quest.id}' is not a string`).toBe('string');
			expect(typeof quest.description, `Quest description in '${quest.id}' is not a string`).toBe(
				'string'
			);
			expect(typeof quest.icon, `Quest icon in '${quest.id}' is not a string`).toBe('string');
			expect(Array.isArray(quest.steps), `Quest '${quest.id}' steps are not an array`).toBe(true);
			expect(
				quest.steps.length,
				`Quest '${quest.id}' does not have at least three steps`
			).toBeGreaterThan(2);
			expect(typeof quest.reward, `Quest reward in '${quest.id}' is not a number`).toBe('number');
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

	it('uses normalized labels for vision-based quest parameters', () => {
		for (const quest of quests) {
			for (const stepGroup of quest.steps) {
				const steps = Array.isArray(stepGroup) ? stepGroup : [stepGroup];
				for (const step of steps) {
					if (step.type === 'take_photo_classification') {
						const [label] = step.parameters;
						expect(label).toBe(normalizeVisionLabel(label));
					}

					if (step.type === 'take_photo_objects') {
						for (const [label] of step.parameters) {
							expect(label).toBe(normalizeVisionLabel(label));
						}
					}

					if (step.type === 'take_photo_location') {
						const [, , , label] = step.parameters;
						if (label !== undefined) {
							expect(label).toBe(normalizeVisionLabel(label));
						}
					}
				}
			}
		}
	});

	it('requires every article_quiz step to use the parameters field', () => {
		for (const quest of quests) {
			for (const stepGroup of quest.steps) {
				const steps = Array.isArray(stepGroup) ? stepGroup : [stepGroup];
				for (const step of steps) {
					if (step.type === 'article_quiz') {
						expect('parameters' in step).toBe(true);
					}
				}
			}
		}
	});

	it('requires every first and last step to be singular and have at least three steps', () => {
		for (const quest of quests) {
			expect(
				quest.steps.length,
				`Quest ${quest.id} does not have at least three steps`
			).toBeGreaterThan(2);
			expect(quest.steps[0], `First step is not singular in quest ${quest.id}`).not.toBeInstanceOf(
				Array
			);
			expect(
				quest.steps[quest.steps.length - 1],
				`Last step is not singular in quest ${quest.id}`
			).not.toBeInstanceOf(Array);
		}
	});

	it('uses valid activity enums in article_quiz and attend_event steps', () => {
		for (const quest of quests) {
			for (const stepGroup of quest.steps) {
				const steps = Array.isArray(stepGroup) ? stepGroup : [stepGroup];
				for (const step of steps) {
					if (step.type === 'article_quiz') {
						const [activityType] = step.parameters;
						expect(validActivityTypes.has(activityType)).toBe(true);
					}

					if (step.type === 'attend_event') {
						const [eventActivity] = step.parameters;
						if (eventActivity.type === 'activity_type') {
							expect(validActivityTypes.has(eventActivity.value)).toBe(true);
						}
					}
				}
			}
		}
	});
});
