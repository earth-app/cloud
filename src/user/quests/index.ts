import { ScoringCriterion } from '../../content/ferry';
import { ActivityType, EventActivity, Rarity } from '../../util/types';

export type Quest = {
	id: string;
	title: string;
	description: string;
	mobile_only?: boolean; // whether the quest can only be completed on mobile devices
	icon: string;
	rarity: Rarity;
	steps: (QuestStep | QuestStep[])[]; // some steps have optional alternatives
	reward: number; // impact points reward for completing the quest
	permissions?: ('location' | 'camera' | 'record')[]; // permissions required to complete the quest
};

export type QuestStep = {
	description: string;
	delay?: number; // seconds after the previous step's first completion before this step unlocks;
	// backfilling additional alternatives of the previous step is still allowed during the wait
	reward?: number; // optional additional impact points on top of overall quest reward
} & (
	| {
			type: 'take_photo_location';
			parameters: [number, number, number, string?, number?]; // latitude, longitude, radius in meters, classification label, confidence threshold
	  }
	| {
			type: 'take_photo_classification';
			parameters: [string, number]; // classification label, confidence threshold
	  }
	| {
			type: 'take_photo_objects';
			parameters: [string, number][]; // object detection labels, confidence threshold
	  }
	| {
			type: 'take_photo_caption';
			parameters: [ScoringCriterion[], string, number]; // rubric criteria, caption prompt, score threshold
	  }
	| {
			type: 'article_quiz';
			parameters: [ActivityType, number]; // article type, score threshold
	  }
	| {
			type: 'draw_picture';
			parameters: [string, number]; // prompt, confidence threshold
	  }
	| {
			type: 'attend_event';
			parameters: [EventActivity, number]; // event activity, minimum attendees
	  }
	| {
			type: 'transcribe_audio';
			parameters: [string, number]; // prompt, accuracy threshold
	  }
	| {
			type: 'match_terms';
			parameters: [string, [string, string][]]; // prompt, list of term pairs to match
	  }
	| {
			type: 'order_items';
			parameters: [string[]]; // list of items to order (in correct order)
	  }
);

export const quests = [
	// normal quests
	{
		id: 'vegetable_head',
		title: 'Vegetable Head',
		description: 'Explore the glory of vegetables by taking photos of them!',
		icon: 'mdi:carrot',
		rarity: 'normal',
		steps: [
			{
				type: 'take_photo_classification',
				description: 'Take a photo of broccoli.',
				parameters: ['broccoli', 0.8]
			},
			{
				type: 'draw_picture',
				description: 'Draw a carrot.',
				parameters: ['carrot', 0.7]
			},
			{
				type: 'take_photo_classification',
				description: 'Take a photo of a cucumber.',
				parameters: ['cucumber', 0.8]
			},
			{
				type: 'take_photo_classification',
				description: 'Take a photo of cauliflower.',
				parameters: ['cauliflower', 0.8],
				reward: 50
			},
			{
				type: 'order_items',
				description: 'Order these vegetables from smallest to largest.',
				parameters: [['pea', 'broccoli', 'carrot', 'tomato', 'cabbage', 'pumpkin']],
				delay: 300
			},
			[
				{
					type: 'take_photo_classification',
					description: 'Take a photo of a bell pepper.',
					parameters: ['bell_pepper', 0.8]
				},
				{
					type: 'take_photo_classification',
					description: 'Take a photo of corn.',
					parameters: ['corn', 0.8]
				}
			],
			{
				type: 'draw_picture',
				description: 'Draw a cabbage.',
				parameters: ['cabbage', 0.7],
				delay: 450
			},
			{
				type: 'take_photo_classification',
				description: 'Take a photo of a mushroom.',
				parameters: ['mushroom', 0.5],
				delay: 600
			}
		],
		reward: 150,
		mobile_only: true,
		permissions: ['camera']
	},
	// rare quests
	{
		id: 'my_aesthetic',
		title: 'My Aesthetic',
		description: 'Express and manage your own aesthetic and creativity!',
		icon: 'mdi:palette',
		rarity: 'rare',
		steps: [
			[
				{
					type: 'take_photo_objects',
					description: 'Take a photo with a dog in it.',
					parameters: [['dog', 0.7]]
				},
				{
					type: 'take_photo_objects',
					description: 'Take a photo with a cat in it.',
					parameters: [['cat', 0.7]]
				}
			],
			{
				type: 'draw_picture',
				description: 'Draw a house.',
				parameters: ['house', 0.7],
				delay: 1200
			},
			[
				{
					type: 'take_photo_objects',
					description: 'Take a photo with an umbrella and a backpack in it.',
					parameters: [
						['umbrella', 0.7],
						['backpack', 0.7]
					]
				},
				{
					type: 'take_photo_objects',
					description: 'Take a photo with a snowboard and skis in it.',
					parameters: [
						['snowboard', 0.7],
						['skis', 0.7]
					],
					reward: 75
				},
				{
					type: 'take_photo_objects',
					description: 'Take a photo with a baseball hat and gloves in it.',
					parameters: [
						['baseball hat', 0.7],
						['baseball glove', 0.7]
					],
					reward: 75
				}
			],
			[
				{
					type: 'take_photo_objects',
					description: 'Take a photo with a stop sign, traffic light, and bus in it.',
					parameters: [
						['stop sign', 0.7],
						['traffic light', 0.7],
						['bus', 0.7]
					],
					reward: 100
				},
				{
					type: 'take_photo_objects',
					description: 'Take a photo with a fork, knife, and spoon in it.',
					parameters: [
						['fork', 0.7],
						['knife', 0.7],
						['spoon', 0.7]
					],
					reward: 50
				}
			],
			{
				type: 'draw_picture',
				description: 'Draw a bicycle.',
				parameters: ['bicycle', 0.7],
				delay: 1800
			},
			[
				{
					type: 'take_photo_classification',
					description: 'Take a photo of an obelisk.',
					parameters: ['obelisk', 0.7],
					reward: 50
				},
				{
					type: 'take_photo_classification',
					description: 'Take a photo of a spider web.',
					parameters: ['spider_web', 0.7]
				},
				{
					type: 'take_photo_classification',
					description: 'Take a photo of a castle.',
					parameters: ['castle', 0.7],
					reward: 100
				}
			],
			{
				type: 'transcribe_audio',
				description: 'Talk about something you find beautiful for 30 seconds.',
				parameters: ['Describe something you find beautiful.', 0.7],
				delay: 2400
			},
			{
				type: 'article_quiz',
				description: 'Read an article about art and complete the quiz with at least 80% accuracy.',
				parameters: ['ART', 0.8],
				delay: 3600
			}
		],
		reward: 500,
		permissions: ['camera', 'record']
	},
	{
		id: 'fun_facts',
		title: 'Fun Facts',
		description: 'Learn some fun facts about the world around you!',
		icon: 'mdi:lightbulb-on',
		rarity: 'rare',
		steps: [
			{
				type: 'article_quiz',
				description:
					'Read an article about home improvement and complete the quiz with at least 80% accuracy.',
				parameters: ['HOME_IMPROVEMENT', 0.8]
			},
			{
				type: 'article_quiz',
				description:
					'Read an article about technology and complete the quiz with at least 75% accuracy.',
				parameters: ['TECHNOLOGY', 0.75]
			},
			[
				{
					type: 'draw_picture',
					description: 'Draw a smartphone.',
					parameters: ['smartphone', 0.7]
				},
				{
					type: 'draw_picture',
					description: 'Draw a laptop.',
					parameters: ['laptop', 0.7],
					reward: 50
				},
				{
					type: 'draw_picture',
					description: 'Draw a television.',
					parameters: ['television', 0.7],
					reward: 75
				}
			],
			{
				type: 'take_photo_caption',
				description: 'Take a photo that represents the concept of "innovation".',
				parameters: [
					[
						{
							id: 'creativity',
							ideal:
								'The caption demonstrates creativity and original thinking in representing innovation.',
							weight: 0.4
						},
						{
							id: 'relevance',
							ideal: 'The caption is relevant and clearly connected to the concept of innovation.',
							weight: 0.3
						},
						{
							id: 'emotional_impact',
							ideal:
								'The caption evokes a strong emotional response that captures the spirit of innovation.',
							weight: 0.3
						}
					],
					'Take a photo that represents the concept of "innovation".',
					0.6
				]
			},
			{
				type: 'order_items',
				description: 'Order these inventions from oldest to newest.',
				parameters: [['wheel', 'printing press', 'steam engine', 'electricity', 'internet']],
				delay: 1200
			},
			{
				type: 'article_quiz',
				description: 'Read an article about health and get a perfect score on the quiz.',
				parameters: ['HEALTH', 1.0]
			}
		],
		reward: 400,
		permissions: ['camera']
	},
	// amazing quests
	{
		id: 'insect_investigator',
		title: 'Insect Investigator',
		description: 'Creepy crawlies need love too! Learn to look into the insects around you.',
		icon: 'mdi:ladybug',
		rarity: 'amazing',
		steps: [
			{
				type: 'take_photo_classification',
				description: 'Take a photo of an ant.',
				parameters: ['ant', 0.8]
			},
			[
				{
					type: 'take_photo_classification',
					description: 'Take a photo of a grasshopper.',
					parameters: ['grasshopper', 0.6],
					reward: 50
				},
				{
					type: 'take_photo_classification',
					description: 'Take a photo of a dragonfly.',
					parameters: ['dragonfly', 0.6],
					reward: 75
				},
				{
					type: 'take_photo_classification',
					description: 'Take a photo of a sulphur butterfly.',
					parameters: ['sulphur_butterfly', 0.5],
					reward: 100
				}
			],
			{
				type: 'take_photo_classification',
				description: 'Take a photo of a ladybug.',
				parameters: ['ladybug', 0.6],
				delay: 1500
			},
			{
				type: 'draw_picture',
				description: 'Draw a butterfly.',
				parameters: ['butterfly', 0.7],
				delay: 1800
			},
			{
				type: 'article_quiz',
				description:
					'Read an article about nature and complete the quiz with at least 75% accuracy.',
				parameters: ['NATURE', 0.75]
			},
			{
				type: 'take_photo_classification',
				description: 'Take a photo of a cicada.',
				parameters: ['cicada', 0.6]
			}
		],
		reward: 600,
		permissions: ['camera']
	},
	// green quests
	{
		id: 'world_tour',
		title: 'World Tour',
		description: 'Explore landmarks around the world and learn about different cultures!',
		icon: 'mdi:earth',
		rarity: 'green',
		steps: [
			{
				type: 'take_photo_location',
				description: 'Take a photo of Jakarta, Indonesia',
				parameters: [-6.2088, 106.8456, 5000]
			},
			[
				{
					type: 'take_photo_location',
					description: 'Take a photo of Paris, France',
					parameters: [48.8566, 2.3522, 5000],
					reward: 150
				},
				{
					type: 'take_photo_location',
					description: 'Take a photo of Mumbai, India',
					parameters: [19.076, 72.8777, 5000],
					reward: 150
				},
				{
					type: 'take_photo_location',
					description: 'Take a photo of Tokyo, Japan',
					parameters: [35.6762, 139.6503, 5000],
					reward: 150
				}
			],
			{
				type: 'take_photo_location',
				description: 'Take a photo of Seoul, South Korea',
				parameters: [37.5665, 126.978, 5000],
				delay: 1200
			},
			[
				{
					type: 'take_photo_location',
					description: 'Take a photo of New York City, USA',
					parameters: [40.7128, -74.006, 5000],
					reward: 150
				},
				{
					type: 'take_photo_location',
					description: 'Take a photo of Los Angeles, USA',
					parameters: [34.0522, -118.2437, 5000],
					reward: 150
				},
				{
					type: 'take_photo_location',
					description: 'Take a photo of Chicago, USA',
					parameters: [41.8781, -87.6298, 5000],
					reward: 150
				}
			],
			{
				type: 'attend_event',
				description: 'Attend a holiday event with at least 50 attendees.',
				parameters: [{ type: 'activity_type', value: 'HOLIDAY' }, 50]
			},
			{
				type: 'take_photo_location',
				description: 'Take a photo of Pikeville, Kentucky, USA',
				parameters: [37.4795, -82.5184, 5000],
				reward: 200,
				delay: 1800
			},
			{
				type: 'take_photo_location',
				description: 'Take a photo of Rio de Janeiro, Brazil',
				parameters: [-22.9068, -43.1729, 5000],
				reward: 150
			},
			{
				type: 'take_photo_location',
				description: 'Take a photo of Sydney, Australia',
				parameters: [-33.8688, 151.2093, 5000],
				reward: 150
			},
			{
				type: 'take_photo_location',
				description: 'Take a photo of Toronto, Canada',
				parameters: [43.6532, -79.3832, 5000],
				reward: 150
			}
		],
		reward: 3000,
		permissions: ['camera', 'location']
	}
] as Quest[];
