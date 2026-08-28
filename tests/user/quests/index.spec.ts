import { describe, expect, it } from 'vitest';
import { quests } from '../../../src/user/quests';
import { ACTIVITY_TYPE } from '../../../src/util/enums';

function normalizeVisionLabel(label: string): string {
	return label.trim().toLowerCase().replace(/\s+/g, '_');
}

const validActivityTypes = new Set<string>(ACTIVITY_TYPE);

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

	/*
	 * A title may be poetic, vague, or plain wrong about the vibe - the ID standard and the title
	 * standard are different (audit §5.2). The one thing a title may not do is state a mechanic the
	 * steps never check, so "...Walk" / "...Hike" / "...Run" has to be backed by a step that
	 * verifies presence or movement.
	 */
	it('never promises locomotion in a title that no step verifies', () => {
		const LOCOMOTION = /\b(walk|walking|hike|hiking|trek|run|running|stroll|roam|wander)\b/i;
		const VERIFIES = new Set(['take_photo_location', 'distance_covered', 'trailmarker_added']);

		for (const quest of quests) {
			const claim = quest.title.match(LOCOMOTION);
			if (!claim) continue;

			const types = new Set<string>();
			for (const stepGroup of quest.steps) {
				for (const step of Array.isArray(stepGroup) ? stepGroup : [stepGroup]) {
					types.add(step.type);
				}
			}

			const verified = [...types].some((type) => VERIFIES.has(type));
			expect(
				verified,
				`Quest '${quest.id}' title "${quest.title}" claims "${claim[0]}" but no step verifies presence or movement`
			).toBe(true);
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

	it('requires mobile_only steps in non-mobile_only quests to provide a non-mobile alternative', () => {
		for (const quest of quests) {
			// mobile_only quests propagate the flag to every step, so no per-step alt is required.
			if (quest.mobile_only) continue;

			for (const stepGroup of quest.steps) {
				if (Array.isArray(stepGroup)) {
					const hasMobileOnly = stepGroup.some((s) => s.mobile_only === true);
					const hasNonMobile = stepGroup.some((s) => s.mobile_only !== true);
					if (hasMobileOnly) {
						expect(
							hasNonMobile,
							`Quest '${quest.id}' has a mobile_only step in an alt group but no non-mobile alternative`
						).toBe(true);
					}
				} else {
					expect(
						stepGroup.mobile_only,
						`Quest '${quest.id}' has a singular mobile_only step but the quest is not mobile_only; provide alternatives or mark the quest mobile_only`
					).not.toBe(true);
				}
			}
		}
	});
});

describe('say_one_thing', () => {
	const quest = quests.find((entry) => entry.id === 'say_one_thing')!;

	it('exists with the four escalating exchanges', () => {
		expect(quest).toBeDefined();
		expect(quest.steps).toHaveLength(4);
	});

	// the whole point of this mechanic is that it needs nothing: no social graph, no feed, no
	// camera, no location. anything else added here is scope that the evidence does not support
	it('asks for no permissions and no hardware', () => {
		expect(quest.permissions).toBeUndefined();
		expect(quest.mobile_only).not.toBe(true);

		for (const stepGroup of quest.steps) {
			for (const step of Array.isArray(stepGroup) ? stepGroup : [stepGroup]) {
				expect(step.type).toBe('describe_text');
				expect(step.mobile_only).not.toBe(true);
			}
		}
	});

	// repeated approaches across a week is the shape that held up a week past the study; four
	// exchanges in one sitting is a different intervention
	it('spreads the exchanges across days rather than one sitting', () => {
		const delays = quest.steps
			.flatMap((stepGroup) => (Array.isArray(stepGroup) ? stepGroup : [stepGroup]))
			.map((step) => step.delay ?? 0);

		expect(delays[0]).toBe(0);
		for (const delay of delays.slice(1)) expect(delay).toBeGreaterThanOrEqual(28800);
	});

	/*
	 * Copy contract, and it is the active ingredient rather than a style preference: the finding is
	 * that people MISPREDICT how these exchanges go, so the quest has to hand the user their own
	 * forecast to check. Telling them to be brave concedes that the fear was warranted.
	 */
	it('frames the ask as a prediction to check, never as courage', () => {
		const copy = [
			quest.description,
			...quest.steps
				.flatMap((stepGroup) => (Array.isArray(stepGroup) ? stepGroup : [stepGroup]))
				.flatMap((step) => [step.description, step.tutorial_hint ?? ''])
		]
			.join(' ')
			.toLowerCase();

		expect(copy).toMatch(/\bexpect(ed|ation)?\b/);
		expect(copy).not.toMatch(/\b(brave|bravery|courage|be bold|don't be shy|nervous|scary)\b/);
	});
});
