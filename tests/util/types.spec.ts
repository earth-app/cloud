import { describe, expect, it } from 'vitest';
import { eventActivitiesList, type Event } from '../../src/util/types';

describe('eventActivitiesList', () => {
	it('normalizes activity_type and activity entries into plain string names', () => {
		const event = {
			id: '1',
			name: 'Event',
			description: 'Desc',
			type: 'IN_PERSON',
			date: Date.now(),
			visibility: 'PUBLIC',
			activities: [
				{ type: 'activity_type', value: 'HOME_IMPROVEMENT' },
				{
					type: 'activity',
					id: 'a',
					name: 'Gardening',
					description: '',
					aliases: [],
					types: ['NATURE'],
					fields: {}
				}
			],
			fields: {}
		} as unknown as Event;

		expect(eventActivitiesList(event)).toEqual(['HOME IMPROVEMENT', 'Gardening']);
	});
});
