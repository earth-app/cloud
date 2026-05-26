import { describe, expect, it } from 'vitest';
import ocean from '@earth-app/ocean';
import { designActivityQuest, MATCH_TERM_DEFINITIONS } from '../../../src/user/quests/activity';
import { ActivityType } from '../../../src/util/types';

describe('activity quests', () => {
	it('has all term definitions defined', () => {
		for (const type of ocean.com.earthapp.activity.ActivityType.values()) {
			expect(MATCH_TERM_DEFINITIONS[type.name]).toBeDefined();
		}
	});

	it('should not have an empty activity quest', () => {
		const typeVariations: ActivityType[][] = [
			['ART', 'HOBBY', 'WORK'],
			['HEALTH', 'ENTERTAINMENT', 'FAMILY'],
			['WORK', 'CREATIVE', 'FINANCE'],
			['HOBBY', 'COMMUNITY_SERVICE', 'HOME_IMPROVEMENT'],
			['WORK', 'HOLIDAY', 'HOBBY'],
			['TECHNOLOGY', 'FASHION', 'HOME_IMPROVEMENT'],
			['STUDY', 'SPORT', 'NATURE'],
			['WORK', 'LEARNING', 'STUDY'],
			['CREATIVE', 'ART', 'LEARNING'],
			['OTHER', 'NATURE', 'FINANCE', 'PETS'],
			['PETS', 'NATURE', 'ART', 'HOBBY', 'OTHER'],
			['NATURE', 'OTHER'],
			['OTHER']
		];

		for (const variation of typeVariations) {
			const quest = designActivityQuest({
				id: 'sample_activity',
				name: 'Sample Activity',
				description: 'This is a sample activity.',
				aliases: [],
				types: variation,
				fields: {}
			});

			expect(quest).toBeDefined();
			expect(quest.steps).toBeDefined();
			expect(quest.steps.length).toBeGreaterThan(2);

			expect(quest.steps[0]).toBeDefined();
			expect(Array.isArray(quest.steps[0])).toBe(false);

			expect(quest.steps[quest.steps.length - 1]).toBeDefined();
			expect(Array.isArray(quest.steps[quest.steps.length - 1])).toBe(false);
		}
	});
});
