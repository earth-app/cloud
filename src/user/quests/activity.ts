import { Quest, QuestStep } from '.';
import { Activity, ActivityType } from '../../util/types';
import { capitalizeFully } from '../../util/util';

const matchTermDescriptions: Record<ActivityType, string> = {
	ART: 'Works that are primarily focused on expression, creativity, and aesthetics',
	COMMUNITY_SERVICE: 'Activities that involve helping or engaging with the community',
	CREATIVE: 'Something that involves creating something new or fresh',
	ENTERTAINMENT: 'Activities that are designed to provide enjoyment and leisure',
	FAMILY: 'Activities that involve spending time with family members',
	FASHION: 'Things related to clothing, style, and personal appearance',
	FINANCE: 'Activities related to managing money, investing, or economics',
	HEALTH: 'Something that promotes physical or mental well-being',
	HOBBY: 'What someone does for fun or relaxation in their free time',
	HOLIDAY: 'Activities related to celebrating holidays or special occasions',
	HOME_IMPROVEMENT: "Activities related to improving or maintaining one's living space",
	LEARNING: 'An activity that involves acquiring new knowledge or skills',
	NATURE: 'Activities that involve being in or appreciating the natural world',
	OTHER: 'An activity that does not fit into the other categories',
	PERSONAL_GOAL:
		'An activity that is focused on self-improvement or achieving a personal milestone',
	PETS: 'Something related to caring for or spending time with pets',
	PROJECT: 'An activity that involves working on a specific project or task',
	RELAXATION: 'Activities that help someone unwind and de-stress',
	SOCIAL: 'When someone interacts with others in person or online for enjoyment or connection',
	SPIRITUALITY:
		'Activities related to exploring or practicing spirituality, religion, or mindfulness',
	SPORT: 'Physical activities that involve skill and exertion, often competitive',
	STUDY: 'An activity focused on academic learning or research',
	TECHNOLOGY:
		'Activities that involve using or engaging with technology, gadgets, or digital platforms',
	TRAVEL: 'Activities related to exploring new places, cultures, or experiences through travel',
	WORK: 'An activity that someone does as part of their job or profession'
};

function createMatchTerms(types: ActivityType[]): [string, string][] {
	const pairs: [string, string][] = [];
	for (const type of types) {
		const description = matchTermDescriptions[type] || type;
		pairs.push([type, description]);
	}

	return pairs;
}

function createOrderItems(activity: Activity): string[] {
	const types = activity.types;
	const items = types.map(
		(type) => `${capitalizeFully(type.replace(/_/g, ' '))}: ${matchTermDescriptions[type] || type}`
	);
	return items;
}

// step 2 - variable based on primary activity type (first type in the list)
function step2(activity: Activity): QuestStep | QuestStep[] {
	const primaryType = activity.types[0];

	switch (primaryType) {
		case 'COMMUNITY_SERVICE': {
			return [
				{
					type: 'attend_event',
					description: `Attend a community event related to ${activity.name}`,
					parameters: [{ type: 'activity_type', value: 'COMMUNITY_SERVICE' }, 5] // minimum attendees
				},
				{
					type: 'take_photo_validation',
					description: `Submit a photo of you participating in a community service event related to ${activity.name}`,
					parameters: [
						`A photo of you participating in a community service event related to ${activity.name}`
					]
				}
			];
		}
		case 'WORK': {
			return {
				type: 'transcribe_audio',
				description: `Transcribe a short audio clip describing your experience with ${activity.name}`,
				parameters: [
					`Please describe your experience with ${activity.name} in a short audio recording.`,
					0.7 // accuracy threshold
				]
			};
		}
		case 'HOBBY':
		case 'TECHNOLOGY': {
			return {
				type: 'describe_text',
				description: `Describe how you use ${activity.name} in your daily life and its impact on you`,
				parameters: [
					[
						{
							id: 'relevance',
							weight: 0.7,
							ideal:
								'The description is highly relevant to the activity and provides specific details about how the user interacts with it.'
						},
						{
							id: 'detail',
							weight: 0.3,
							ideal:
								"The description provides detailed information about the user's experience with the activity."
						}
					],
					0.7 // score threshold
				]
			};
		}
		case 'PERSONAL_GOAL': {
			return {
				type: 'article_quiz',
				description: `Read an article on personal goal setting and complete a quiz with at least 80% accuracy`,
				parameters: ['PERSONAL_GOAL', 0.8] // article type, score threshold
			};
		}
		case 'SOCIAL': {
			return {
				type: 'describe_text',
				description: `Describe a memorable social experience you've had related to ${activity.name} and why it was meaningful to you`,
				parameters: [
					[
						{
							id: 'emotional_impact',
							weight: 0.5,
							ideal:
								'The description effectively conveys the emotional significance of the social experience related to the activity.'
						},
						{
							id: 'specificity',
							weight: 0.3,
							ideal:
								'The description provides specific details about the social experience, including who was involved and what made it memorable.'
						},
						{
							id: 'relevance',
							weight: 0.2,
							ideal: 'The description is highly relevant to the activity and the social experience.'
						}
					],
					0.7 // score threshold
				]
			};
		}
		default: {
			return {
				type: 'draw_picture',
				description: `Draw a picture representing ${activity.name}`,
				parameters: [`Draw a picture representing ${activity.name}`, 0.5]
			};
		}
	}
}

function middleSteps(activity: Activity): (QuestStep | QuestStep[])[] {
	const middleSteps: (QuestStep | QuestStep[])[] = [];

	// step 4 - attend_event or describe_text
	middleSteps.push([
		{
			type: 'attend_event',
			description: `Attend an event involved with ${activity.name}`,
			parameters: [{ type: 'activity', ...activity }, 10], // minimum attendees
			reward: 100
		},
		{
			type: 'describe_text',
			description: `Describe your feelings about ${activity.name}.`,
			parameters: [
				[
					{
						id: 'creativity',
						weight: 0.5,
						ideal: 'The writing should be creative and expressive in length and depth'
					},
					{
						id: 'depth',
						weight: 0.3,
						ideal:
							'The writing should be deep, meaningful, and effective about why the acitvity is important to the user'
					},
					{
						id: 'originality',
						weight: 0.2,
						ideal:
							"The writing should be the user's own voice and effectively detail why the activity is special, unique to themselves"
					}
				],
				0.3,
				350
			],
			reward: 100
		}
	]);

	// step 5 - variable group
	const step5: QuestStep[] = [];
	if (activity.types.length >= 4) {
		// add uncovered type quiz options
		const uncoveredTypes = activity.types.slice(0, activity.types.length - 3);
		step5.push(
			...uncoveredTypes.map(
				(type) =>
					({
						type: 'article_quiz',
						description: `Read an article about ${type.replace(/_/g, ' ')} and complete a quiz with at least 75% accuracy`,
						parameters: [type, 0.75], // article type, score threshold
						reward: 50
					}) satisfies QuestStep
			)
		);
	}

	step5.push(
		...([
			{
				type: 'match_terms',
				description: `Match the following terms related to ${activity.name} with their correct descriptions`,
				parameters: [activity.name, createMatchTerms(activity.types)],
				reward: 50
			},
			{
				type: 'order_items',
				description: `Put the following types of ${activity.name} in order from most to least relevant to the activity`,
				parameters: [createOrderItems(activity)],
				reward: 50
			},
			{
				type: 'transcribe_audio',
				description: `Explain how ${activity.name} works and how you would teach it to someone else`,
				parameters: [
					`Please explain how ${activity.name} works and how you would teach it to someone else in a short audio recording.`,
					0.6 // accuracy threshold
				],
				reward: 50
			}
		] satisfies QuestStep[])
	);
	middleSteps.push(step5);

	// step 6 - if there are more than 4 types, add another article quiz on a middle type not already covered
	if (activity.types.length > 4) {
		// Ensure we don't duplicate types from step 3 (last 3) or step 5 (first uncovered)
		// For 5+ types, step 3 covers the last 3, step 5 covers the first (length-3)
		// So types[1] (if exists and not in step 3/5) could be covered here
		// For 5 types: step3=[2,3,4], step5=[0,1]. types[1] is in step5, so skip.
		// For 6 types: step3=[3,4,5], step5=[0,1,2]. types[1] is in step5, so skip.
		// types[1] is always covered. This step appears to be redundant, so we skip it.
		// If more variety is desired, consider adding different step types instead.
	}

	// step 7 - if the description contains more than 100 words, add a describe_text step asking the user to summarize the description in their own words with a score threshold of 0.5
	if (activity.description.split(' ').length > 100) {
		middleSteps.push({
			type: 'describe_text',
			description: `Summarize the following description of ${activity.name} in your own words: ${activity.description}`,
			parameters: [
				[
					{
						id: 'accuracy',
						weight: 0.7,
						ideal:
							'The summary should accurately capture the main points of the original description while being concise.'
					},
					{
						id: 'originality',
						weight: 0.3,
						ideal:
							"The summary should be written in the user's own words and not copy phrases directly from the original description."
					}
				],
				0.5,
				50
			],
			reward: 50,
			delay: 24 * 60 * 60 // 24 hour delay before this step unlocks after completing the previous step
		});
	}

	return middleSteps;
}

export async function getActivity(id: string): Promise<Activity> {
	const url = `https://api.earth-app.com/v2/activities/${id}`;

	const response = await fetch(url);
	const activity = await response.json<Activity>();
	return activity;
}

export function designActivityQuest(activity: Activity): Quest {
	const steps: (QuestStep | QuestStep[])[] = [];

	// step 1 - take_photo_validation
	steps.push({
		type: 'take_photo_validation',
		description: `Submit a photo of ${activity.name} in action`,
		parameters: [`A photo or screenshot of ${activity.name} in action`]
	});

	// step 2 - variable
	steps.push(step2(activity));

	// step 3 - article quiz choices on bottom 3 activity types (or all if less than 3)
	const topTypes = activity.types.slice(Math.max(0, activity.types.length - 3));
	const step3: QuestStep[] = topTypes.map((type) => ({
		type: 'article_quiz',
		description: `Read an article about ${type.replace(/_/g, ' ')} and complete a quiz with at least 80% accuracy`,
		parameters: [type, 0.8], // article type, score threshold
		reward: 150,
		delay: 24 * 60 * 60 // 24 hour delay before this step unlocks after completing the previous step
	}));
	steps.push(step3);

	// middle steps (steps 4 up to 7) - variable
	steps.push(...middleSteps(activity));

	// final step - article_quiz on last activity type with 100% accuracy
	const lastType = activity.types[activity.types.length - 1];
	steps.push({
		type: 'article_quiz',
		description: `Read an article about "${capitalizeFully(lastType.replace(/_/g, ' '))}" and complete a quiz with 100% accuracy`,
		parameters: [lastType, 1.0], // article type, score threshold
		delay: 24 * 60 * 60, // 24 hour delay before this step unlocks after completing the previous step
		reward: 250
	});

	return {
		id: `activity_quest_${activity.id}`,
		title: `Explore ${activity.name}`,
		icon: activity.fields['icon'] || 'material-symbols:activity-zone',
		steps,
		description: `Learn more about ${activity.name} by completing this quest!`,
		rarity: 'normal',
		reward: 250
	};
}
