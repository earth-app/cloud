import { ScoringCriterion } from '../../content/ferry';
import { ActivityType, ActivityOrType, Rarity, Bindings } from '../../util/types';
import { designActivityQuest } from './activity';
import { getActivity } from '../../util/mantle2';
import { CustomQuest, getCustomQuest, getCustomQuests } from './custom';
import {
	getMasteryQuest,
	masteryBadgeIdFromQuestId,
	MASTERY_QUEST_ID_PREFIX
} from '../badges/mastery';
import type { QuestClassificationLabel, QuestObjectLabel } from '../../util/ai';
import { BarcodeResolution } from './validation';
import { prewarmBuiltInHashes } from './migration';

export type Quest = {
	id: string;
	title: string;
	description: string;
	mobile_only?: boolean; // whether the quest can only be completed on mobile devices
	icon: string;
	rarity: Rarity;
	steps: (QuestStep | QuestStep[])[]; // some steps have optional alternatives
	premium?: boolean;
	reward: number; // impact points reward for completing the quest
	permissions?: ('location' | 'camera' | 'record' | 'motion')[]; // permissions required to complete the quest - optional because they are requested anyways, but helps upfront
};

export type QuestStep = {
	description: string;
	delay?: number; // seconds after the previous step's first completion before this step unlocks;
	// backfilling additional alternatives of the previous step is still allowed during the wait
	reward?: number; // optional additional impact points on top of overall quest reward
	mobile_only?: boolean; // whether this step is only available on mobile - meaning that alternatives must be provided
	// short coaching string shown to first-quest users above the step input
	tutorial_hint?: string;
} & (
	| {
			type: 'take_photo_location';
			parameters: [number, number, number, QuestClassificationLabel?, number?]; // latitude, longitude, radius in meters, classification label, confidence threshold
	  }
	| {
			type: 'take_photo_classification';
			parameters: [QuestClassificationLabel, number]; // classification label, confidence threshold
	  }
	| {
			type: 'take_photo_objects';
			parameters: [QuestObjectLabel, number][]; // object detection labels, confidence threshold
	  }
	| {
			type: 'take_photo_caption';
			parameters: [ScoringCriterion[], string, number]; // rubric criteria, caption prompt, score threshold
	  }
	| {
			type: 'take_photo_validation';
			parameters: [string, number?]; // validation prompt, optional score threshold (default 0.5)
	  }
	| {
			type: 'take_photo_list';
			parameters: [string[], number?]; // list of objects, optional score threshold (default 0.5)
	  }
	| {
			type: 'article_quiz'; // handled automatically by cloud
			parameters: [ActivityType, number]; // article type, score threshold
	  }
	| {
			type: 'draw_picture';
			parameters: [string, number]; // prompt, confidence threshold
	  }
	| {
			type: 'attend_event'; // handled over mantle2
			parameters: [ActivityOrType, number]; // activity, minimum attendees
	  }
	| {
			type: 'respond_to_prompt'; // handled over mantle2
			parameters: [string, number?]; // keyword, optional author id
	  }
	| {
			type: 'article_read_time';
			parameters: [ActivityType, number]; // article type, minimum read time in seconds
	  }
	| {
			type: 'activity_read_time';
			parameters: [ActivityOrType, number]; // activity, minimum read time in seconds
	  }
	| {
			type: 'nature_minutes'; // outdoor minutes, validated in cloud against the nature-minutes ledger
			parameters: [number]; // target minutes to accumulate since the step first became achievable
	  }
	| {
			type: 'trailmarker_added'; // validated in cloud against the user's own trailmark index
			parameters: [string?, number?]; // optional keyword the note must contain, optional author id
	  }
	| {
			type: 'transcribe_audio';
			parameters: [string, number, number?]; // prompt, accuracy threshold, minimum time in seconds
	  }
	| {
			type: 'match_terms';
			parameters: [string, [string, string][]]; // prompt, list of term pairs to match
	  }
	| {
			type: 'order_items';
			parameters: [string[]]; // list of items to order (in correct order)
	  }
	| {
			type: 'describe_text';
			parameters: [ScoringCriterion[], number, number?, number?]; // rubric criteria, score threshold, min length, max length
	  }
	| {
			type: 'submit_event_image';
			parameters: [ActivityOrType, number]; // activity, score (0.0 - 1.0)
	  }
	| {
			type: 'distance_covered';
			parameters: [number]; // minimum distance (meters)
			mobile_only: true;
	  }
	| {
			type: 'scan_barcode';
			parameters: [BarcodeResolution['kind'], string?]; // scan type, keyword (optional)
			mobile_only: true;
	  }
);

export const quests = [
	// #region normal quests
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
				parameters: ['broccoli', 0.6]
			},
			{
				type: 'draw_picture',
				description: 'Draw a carrot.',
				parameters: ['carrot', 0.7]
			},
			{
				type: 'take_photo_classification',
				description: 'Take a photo of a cucumber.',
				parameters: ['cucumber', 0.6]
			},
			{
				type: 'take_photo_classification',
				description: 'Take a photo of cauliflower.',
				parameters: ['cauliflower', 0.6],
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
					parameters: ['bell_pepper', 0.6]
				},
				{
					type: 'take_photo_classification',
					description: 'Take a photo of corn.',
					parameters: ['corn', 0.6]
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
	{
		id: 'out_and_about',
		title: 'Out and About',
		description: 'Get outside and explore your surroundings by taking photos of things in nature!',
		icon: 'mdi:pine-tree',
		rarity: 'normal',
		steps: [
			{
				type: 'take_photo_objects',
				description: 'Take a photo of a bicycle.',
				parameters: [['bicycle', 0.8]]
			},
			[
				{
					type: 'take_photo_classification',
					description: 'Take a photo of an umbrella.',
					parameters: ['umbrella', 0.8]
				},
				{
					type: 'take_photo_classification',
					description: 'Take a photo of a backpack.',
					parameters: ['backpack', 0.8]
				},
				{
					type: 'take_photo_classification',
					description: 'Take a photo of a balloon.',
					parameters: ['balloon', 0.8]
				}
			],
			{
				type: 'attend_event',
				description: 'Attend an outdoor sports event with at least 3 attendees.',
				parameters: [{ type: 'activity_type', value: 'SPORT' }, 3],
				delay: 300
			},
			[
				{
					type: 'article_quiz',
					description:
						'Read an article about hobbies and complete the quiz with at least 80% accuracy.',
					parameters: ['HOBBY', 0.8]
				},
				{
					type: 'article_quiz',
					description:
						'Read an article about sports and complete the quiz with at least 80% accuracy.',
					parameters: ['SPORT', 0.8]
				}
			],
			{
				type: 'draw_picture',
				description: 'Draw a tree.',
				parameters: ['tree', 0.7],
				delay: 600
			}
		],
		reward: 200,
		permissions: ['camera']
	},
	{
		id: 'sound_sensation',
		title: 'Sound Sensation',
		description: 'Use your voice to complete these fun and creative challenges!',
		icon: 'mdi:microphone',
		rarity: 'normal',
		steps: [
			{
				type: 'transcribe_audio',
				description: 'Describe something that makes you happy for 30 seconds.',
				parameters: ['Describe something that makes you happy.', 0.7, 30]
			},
			{
				type: 'transcribe_audio',
				description: 'Describe your favorite food for 30 seconds.',
				parameters: ['Describe your favorite food.', 0.7, 30]
			},
			{
				type: 'transcribe_audio',
				description: 'Describe your favorite place for 30 seconds.',
				parameters: ['Describe your favorite place.', 0.7, 30],
				delay: 1200
			},
			[
				{
					type: 'transcribe_audio',
					description: 'Describe your favorite hobby for 1 minute.',
					parameters: ['Describe your favorite hobby.', 0.7, 60],
					reward: 50
				},
				{
					type: 'transcribe_audio',
					description: 'Describe your favorite animal for 30 seconds.',
					parameters: ['Describe your favorite animal.', 0.7, 30],
					reward: 50
				}
			],
			{
				type: 'article_quiz',
				description:
					'Read an article about entertainment and complete the quiz with at least 80% accuracy.',
				parameters: ['ENTERTAINMENT', 0.8],
				delay: 1800
			}
		],
		reward: 250,
		permissions: ['record']
	},
	{
		id: 'chicagoland',
		title: 'Chicagoland Explorer',
		description:
			'Explore the city of Chicago by taking photos of its iconic landmarks and attractions!',
		icon: 'mdi:city',
		premium: true,
		rarity: 'normal',
		steps: [
			{
				type: 'take_photo_location',
				description: 'Take a photo of the Cloud Gate sculpture (aka "The Bean").',
				parameters: [41.8827, -87.6233, 100]
			},
			{
				type: 'take_photo_location',
				description: 'Take a photo of the Willis Tower (aka "Sears Tower").',
				parameters: [41.8789, -87.6359, 100],
				delay: 300
			},
			{
				type: 'take_photo_location',
				description: 'Take a photo of the Navy Pier.',
				parameters: [41.8917, -87.6091, 400],
				delay: 600
			},
			[
				{
					type: 'draw_picture',
					description: 'Draw a map of Illinois.',
					parameters: ['a map of Illinois', 0.55],
					reward: 25
				},
				{
					type: 'draw_picture',
					description: 'Draw a map of the Chicago city limits.',
					parameters: ['a map of Chicago', 0.55],
					reward: 50
				}
			],
			{
				type: 'order_items',
				description: 'Order these Chicago landmarks from north to south.',
				parameters: [['Wrigley Field', 'Lincoln Park', 'Navy Pier', 'Willis Tower']]
			},
			[
				{
					type: 'article_quiz',
					description:
						'Read an article about work and complete the quiz with 100% score on the quiz.',
					parameters: ['WORK', 1.0]
				},
				{
					type: 'article_quiz',
					description: 'Read an article about travel and complete the quiz with 100% accuracy.',
					parameters: ['TRAVEL', 1.0]
				}
			],
			{
				type: 'take_photo_location',
				description: 'Take a photo of the Chicago River.',
				parameters: [41.888, -87.6295, 100]
			}
		],
		reward: 300,
		permissions: ['camera']
	},
	{
		id: 'runner',
		title: 'Runner',
		description: 'Enjoy the outdoors with the love for running!',
		mobile_only: true,
		icon: 'mdi:run-fast',
		rarity: 'normal',
		steps: [
			{
				type: 'match_terms',
				description: 'Match the track events to their corresponding descriptions.',
				parameters: [
					'Match the track events to their corresponding descriptions.',
					[
						['60m', 'One long straight run on the indoor track'],
						['60mH', 'One long straight run on the indoor track with hurdles'],
						['100m', 'One long straight run on the outdoor track'],
						['110mH', 'One long straight run on the outdoor track with hurdles'],
						['200m', 'A full lap on the indoor track'],
						['400m', 'A full lap on the outdoor track'],
						['600m', 'Three laps on the indoor track'],
						['800m', 'Half of a mile run'],
						['1600m', 'A full mile run'],
						['3200m', 'Two miles worth of a run']
					]
				]
			},
			[
				{
					type: 'respond_to_prompt',
					description: 'Respond to a prompt about running.',
					parameters: ['running']
				},
				{
					type: 'article_read_time',
					description: 'Read articles about sports for at least 15 minutes.',
					parameters: ['SPORT', 15 * 60]
				}
			],
			{
				type: 'distance_covered',
				description: 'Run 1 mile.',
				parameters: [1600]
			},
			{
				type: 'take_photo_validation',
				description: 'Take a photo of your shoes.',
				parameters: ['shoes', 0.6],
				delay: 14400
			},
			[
				{
					type: 'submit_event_image',
					description: 'Submit a photo at a sports event with at least a B score.',
					parameters: [{ type: 'activity_type', value: 'SPORT' }, 0.8],
					reward: 25
				},
				{
					type: 'transcribe_audio',
					description: 'Describe why running is beneficial for 45 seconds.',
					parameters: ['why running is beneficial', 0.65, 45]
				}
			],
			[
				{
					type: 'scan_barcode',
					description: 'Scan a barcode for a book on "running".',
					parameters: ['book', 'running'],
					reward: 75
				},
				{
					type: 'describe_text',
					description: 'Describe your favorite running route.',
					parameters: [
						[
							{
								id: 'relevance',
								ideal: 'The response directly addresses the prompt about a favorite running route.'
							},
							{
								id: 'depth',
								ideal:
									'The response is thoughtful and shows substantive detail rather than a one-line answer.'
							},
							{
								id: 'originality',
								ideal: "The response is in the user's own voice and includes specific examples."
							}
						],
						0.6,
						75
					]
				},
				{
					type: 'article_quiz',
					description:
						'Read an article about sports and complete the quiz with at least an 80% score.',
					parameters: ['SPORT', 0.8]
				}
			],
			{
				type: 'distance_covered',
				description: 'Run 2 miles.',
				parameters: [3200],
				delay: 28800,
				reward: 100
			}
		],
		reward: 300,
		permissions: ['camera', 'motion']
	},
	{
		id: 'first_light_walk',
		title: 'First Light Walk',
		description:
			'Head out while the day is still deciding what it wants to be, and gather the quiet of first light.',
		icon: 'mdi:weather-sunset-up',
		rarity: 'normal',
		steps: [
			{
				type: 'take_photo_validation',
				description: 'Take a photo of the early morning light on something ordinary.',
				parameters: ['early morning light falling on an everyday object or scene', 0.5]
			},
			[
				{
					type: 'respond_to_prompt',
					description: 'Respond to a prompt about mornings.',
					parameters: ['morning']
				},
				{
					type: 'transcribe_audio',
					description: 'Describe how the morning air feels for 20 seconds.',
					parameters: ['Describe how the morning air feels.', 0.65, 20],
					reward: 30
				},
				{
					type: 'nature_minutes',
					description: 'Spend at least 15 minutes outside in the early light.',
					parameters: [15],
					reward: 40
				}
			],
			{
				type: 'article_quiz',
				description:
					'Read an article about nature and complete the quiz with at least 70% accuracy.',
				parameters: ['NATURE', 0.7],
				delay: 300
			},
			{
				type: 'draw_picture',
				description: 'Draw the sky the way you saw it this morning.',
				parameters: ['a morning sky', 0.6]
			}
		],
		reward: 150,
		permissions: ['camera', 'record']
	},
	{
		id: 'backyard_botanist',
		title: 'Backyard Botanist',
		description:
			'You do not need a forest. Learn to see the wild things already growing at your feet.',
		icon: 'mdi:sprout',
		rarity: 'normal',
		steps: [
			{
				type: 'take_photo_validation',
				description: 'Take a photo of a plant growing where no one planted it.',
				parameters: ['a wild plant or weed growing in a crack, lawn, or untended spot', 0.5]
			},
			{
				type: 'take_photo_list',
				description: 'Take a photo that includes a leaf, a stem, and a flower or bud.',
				parameters: [['leaf', 'stem', 'flower'], 0.5],
				reward: 25
			},
			[
				{
					type: 'match_terms',
					description: 'Match each plant part to what it does.',
					parameters: [
						'Match each plant part to what it does.',
						[
							['Roots', 'Draw up water and anchor the plant'],
							['Leaves', 'Turn sunlight into food'],
							['Stem', 'Carry water and hold the plant upright'],
							['Flower', 'Attract pollinators and make seeds'],
							['Seed', 'Carry the next generation']
						]
					]
				},
				{
					type: 'order_items',
					description: 'Order the life of a flowering plant from first to last.',
					parameters: [['seed', 'sprout', 'leaves', 'bud', 'flower', 'fruit']],
					reward: 25
				}
			],
			{
				type: 'article_quiz',
				description:
					'Read an article about nature and complete the quiz with at least 70% accuracy.',
				parameters: ['NATURE', 0.7],
				delay: 300
			},
			{
				type: 'draw_picture',
				description: 'Draw the plant you found today.',
				parameters: ['a plant with leaves and a flower', 0.6]
			}
		],
		reward: 175,
		permissions: ['camera']
	},
	{
		id: 'sky_report',
		title: 'Sky Report',
		description:
			'The sky puts on a different show every day and almost no one files a report. Be the one who looks up.',
		icon: 'mdi:weather-partly-cloudy',
		rarity: 'normal',
		steps: [
			{
				type: 'take_photo_validation',
				description: 'Take a photo of the sky right now, whatever it is doing.',
				parameters: ['the sky, showing clouds, clear blue, or weather', 0.45]
			},
			[
				{
					type: 'match_terms',
					description: 'Match each cloud to what it usually tells you.',
					parameters: [
						'Match each cloud type to what it usually means.',
						[
							['Cumulus', 'Fair weather, puffy and white'],
							['Stratus', 'Grey overcast, maybe drizzle'],
							['Cirrus', 'High and wispy, change on the way'],
							['Cumulonimbus', 'Tall and dark, storms building'],
							['Nimbostratus', 'Thick and low, steady rain']
						]
					]
				},
				{
					type: 'order_items',
					description: 'Order these from lowest to highest in the sky.',
					parameters: [['fog', 'cumulus', 'cirrus', 'jet stream', 'the moon']],
					reward: 25
				}
			],
			{
				type: 'article_quiz',
				description:
					'Read an article about nature and complete the quiz with at least 70% accuracy.',
				parameters: ['NATURE', 0.7]
			},
			{
				type: 'describe_text',
				description: 'Describe the sky today in your own words.',
				parameters: [
					[
						{
							id: 'observation',
							weight: 0.5,
							ideal:
								'The response describes what the sky actually looks like right now with specific detail.'
						},
						{
							id: 'voice',
							weight: 0.5,
							ideal:
								"The response is in the writer's own words and shows genuine attention rather than a generic line."
						}
					],
					0.55,
					40
				]
			}
		],
		reward: 150,
		permissions: ['camera']
	},
	{
		id: 'follow_the_water',
		title: 'Follow the Water',
		description:
			'Every drop near you is going somewhere. Trace a little of that journey and see where water lives around you.',
		icon: 'mdi:water',
		rarity: 'normal',
		steps: [
			{
				type: 'take_photo_validation',
				description:
					'Take a photo of water in any form - a puddle, a stream, a fountain, or rain on a window.',
				parameters: ['water in any form, such as a puddle, stream, fountain, or rain', 0.45]
			},
			{
				type: 'order_items',
				description: 'Order the stages of the water cycle.',
				parameters: [
					['evaporation', 'condensation', 'clouds', 'precipitation', 'runoff', 'collection']
				],
				reward: 25
			},
			[
				{
					type: 'respond_to_prompt',
					description: 'Respond to a prompt about water.',
					parameters: ['water']
				},
				{
					type: 'article_quiz',
					description:
						'Read an article about nature and complete the quiz with at least 75% accuracy.',
					parameters: ['NATURE', 0.75],
					reward: 40
				}
			],
			{
				type: 'draw_picture',
				description: 'Draw a river winding through a landscape.',
				parameters: ['a river winding through a landscape', 0.6],
				delay: 300
			}
		],
		reward: 140,
		permissions: ['camera']
	},
	{
		id: 'bark_and_stone',
		title: 'A Hand on the Bark',
		description:
			'Some of the world is meant for your hands, not your eyes. Go touch the outside and report back.',
		icon: 'mdi:hand-back-right',
		rarity: 'normal',
		steps: [
			{
				type: 'take_photo_validation',
				description: 'Take a close photo of a rough natural texture - bark, stone, or moss.',
				parameters: ['a close-up of a rough natural texture such as tree bark, stone, or moss', 0.5]
			},
			{
				type: 'take_photo_list',
				description: 'Take photos of three different natural textures.',
				parameters: [['tree bark', 'a rock', 'a leaf'], 0.5],
				reward: 30
			},
			[
				{
					type: 'describe_text',
					description: 'Describe how one texture felt under your fingers.',
					parameters: [
						[
							{
								id: 'sensory',
								weight: 0.6,
								ideal:
									'The response describes the physical feel of the texture with specific sensory detail.'
							},
							{
								id: 'voice',
								weight: 0.4,
								ideal: "The response is in the writer's own words and shows real attention."
							}
						],
						0.55,
						30
					]
				},
				{
					type: 'transcribe_audio',
					description: 'Describe a texture you touched today for 20 seconds.',
					parameters: ['Describe a texture you touched today.', 0.65, 20],
					reward: 30
				}
			],
			{
				type: 'draw_picture',
				description: 'Draw the pattern you found in the bark or stone.',
				parameters: ['a close-up texture pattern of bark or stone', 0.55]
			}
		],
		reward: 160,
		permissions: ['camera', 'record']
	},
	{
		id: 'one_good_walk',
		title: 'One Good Walk',
		description:
			'No route, no goal, no step count to hit. Just a walk that is only about the walk.',
		icon: 'mdi:walk',
		rarity: 'normal',
		steps: [
			{
				type: 'take_photo_validation',
				description: 'Take a photo of something you would have walked right past.',
				parameters: ['a small, easily-overlooked detail found outdoors', 0.45]
			},
			[
				{
					type: 'distance_covered',
					description: 'Take a slow walk of at least half a mile.',
					parameters: [800],
					mobile_only: true
				},
				{
					type: 'article_read_time',
					description: 'Read articles about nature for at least 5 minutes.',
					parameters: ['NATURE', 5 * 60]
				},
				{
					type: 'nature_minutes',
					description: 'Spend at least 15 minutes outside on your walk.',
					parameters: [15],
					reward: 40
				}
			],
			{
				type: 'respond_to_prompt',
				description: 'Respond to a prompt about being outside.',
				parameters: ['outside'],
				delay: 300
			},
			{
				type: 'describe_text',
				description: 'Describe one thing the walk let you notice.',
				parameters: [
					[
						{
							id: 'noticing',
							weight: 0.6,
							ideal: 'The response names a specific thing noticed on the walk with real detail.'
						},
						{
							id: 'voice',
							weight: 0.4,
							ideal: "The response is genuine and in the writer's own voice."
						}
					],
					0.55,
					30
				]
			}
		],
		reward: 150,
		permissions: ['camera', 'motion']
	},
	// #region rare quests
	{
		id: 'my_aesthetic',
		title: 'My Aesthetic',
		description: 'Express and manage your own aesthetic and creativity!',
		icon: 'mdi:palette',
		rarity: 'rare',
		steps: [
			{
				type: 'take_photo_caption',
				description: 'Take a photo that represents your personal style.',
				parameters: [
					[
						{
							id: 'creativity',
							ideal:
								"The caption demonstrates creativity and originality in representing the user's personal style.",
							weight: 0.4
						},
						{
							id: 'aesthetic_coherence',
							ideal:
								"The caption reflects a coherent and consistent aesthetic that effectively captures the user's personal style.",
							weight: 0.4
						},
						{
							id: 'emotional_expression',
							ideal:
								"The caption conveys a strong emotional expression that resonates with the user's personal style.",
							weight: 0.2
						}
					],
					'Take a photo that represents your personal style.',
					0.6
				]
			},
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
						['snowboard', 0.5],
						['skis', 0.5]
					],
					reward: 75
				},
				{
					type: 'take_photo_objects',
					description: 'Take a photo with a baseball bat and glove in it.',
					parameters: [
						['baseball_bat', 0.7],
						['baseball_glove', 0.7]
					],
					reward: 75
				}
			],
			[
				{
					type: 'take_photo_objects',
					description: 'Take a photo with a stop sign, traffic light, and bus in it.',
					parameters: [
						['stop_sign', 0.7],
						['traffic_light', 0.7],
						['bus', 0.7]
					],
					reward: 100
				},
				{
					type: 'take_photo_objects',
					description: 'Take a photo with a fork, knife, and spoon in it.',
					parameters: [
						['fork', 0.55],
						['knife', 0.55],
						['spoon', 0.55]
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
				parameters: ['Describe something you find beautiful.', 0.7, 30],
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
	{
		id: 'event_attendee',
		title: 'Event Attendee',
		description:
			'Attend events in your community and learn about the activities happening around you!',
		icon: 'mdi:account-group',
		rarity: 'rare',
		steps: [
			{
				type: 'attend_event',
				description: 'Attend an entertainment event with at least 20 attendees.',
				parameters: [{ type: 'activity_type', value: 'ENTERTAINMENT' }, 20]
			},
			{
				type: 'attend_event',
				description: 'Attend a sports event with at least 20 attendees.',
				parameters: [{ type: 'activity_type', value: 'SPORT' }, 20],
				delay: 600
			},
			{
				type: 'attend_event',
				description: 'Attend a holiday event with at least 50 attendees.',
				parameters: [{ type: 'activity_type', value: 'HOLIDAY' }, 50],
				delay: 1200
			},
			{
				type: 'attend_event',
				description: 'Attend a community service event with at least 20 attendees.',
				parameters: [{ type: 'activity_type', value: 'COMMUNITY_SERVICE' }, 20],
				delay: 1800
			},
			[
				{
					type: 'attend_event',
					description: 'Attend a social event with at least 20 attendees.',
					parameters: [{ type: 'activity_type', value: 'SOCIAL' }, 20],
					reward: 50
				},
				{
					type: 'attend_event',
					description: 'Attend an art event with at least 20 attendees.',
					parameters: [{ type: 'activity_type', value: 'ART' }, 20],
					reward: 50
				},
				{
					type: 'attend_event',
					description: 'Attend a technology event with at least 20 attendees.',
					parameters: [{ type: 'activity_type', value: 'TECHNOLOGY' }, 20],
					reward: 50
				}
			],
			{
				type: 'article_quiz',
				description:
					'Read an article about community involvement and complete the quiz with at least 80% accuracy.',
				parameters: ['COMMUNITY_SERVICE', 0.8],
				delay: 2400
			}
		],
		reward: 350,
		permissions: ['location']
	},
	{
		id: 'researcher',
		title: 'Researcher',
		description:
			'Conduct research by gathering data and analyzing it to draw conclusions about the world around you!',
		icon: 'mdi:magnify',
		rarity: 'rare',
		steps: [
			{
				type: 'article_quiz',
				description:
					'Read an article about studying and complete the quiz with at least 60% accuracy.',
				parameters: ['STUDY', 0.6]
			},
			[
				{
					type: 'take_photo_classification',
					description: 'Take a photo of a petri dish.',
					parameters: ['petri_dish', 0.7],
					reward: 50
				},
				{
					type: 'article_quiz',
					description:
						'Read an article about technology and complete the quiz with at least 80% accuracy.',
					parameters: ['TECHNOLOGY', 0.8],
					delay: 1200
				}
			],
			{
				type: 'order_items',
				description: 'Order these planets from closest to farthest from the sun.',
				parameters: [
					['Mercury', 'Venus', 'Earth', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune']
				]
			},
			{
				type: 'article_quiz',
				description:
					'Read an article about a project and complete the quiz with at least 60% accuracy.',
				parameters: ['PROJECT', 0.6],
				delay: 1200
			},
			{
				type: 'draw_picture',
				description: 'Draw a galaxy.',
				parameters: ['galaxy', 0.7],
				reward: 50
			},
			[
				{
					type: 'match_terms',
					description: 'Match the scientist to their discovery.',
					parameters: [
						'Match the scientist to their discovery.',
						[
							['Isaac Newton', 'Gravity'],
							['Marie Curie', 'Radioactivity'],
							['Albert Einstein', 'Relativity'],
							['Charles Darwin', 'Evolution'],
							['Nikola Tesla', 'Alternating Current'],
							['Galileo Galilei', 'Heliocentrism'],
							['Rosalind Franklin', 'DNA Structure'],
							['Kip Thorne', 'Gravitational Waves'],
							['James Clerk Maxwell', 'Electromagnetism']
						]
					]
				},
				{
					type: 'match_terms',
					description: 'Match each discovery or invention to the person most associated with it.',
					parameters: [
						'Match each discovery or invention to the person most associated with it.',
						[
							['Telephone', 'Alexander Graham Bell'],
							['Practical Incandescent Light Bulb', 'Thomas Edison'],
							['Airplane', 'Wright Brothers'],
							['Printing Press', 'Johannes Gutenberg'],
							['Improved Steam Engine', 'James Watt'],
							['Penicillin', 'Alexander Fleming'],
							['World Wide Web', 'Tim Berners-Lee'],
							['Radio', 'Guglielmo Marconi'],
							['Theory of Evolution', 'Charles Darwin'],
							['Alternating Current System', 'Nikola Tesla']
						]
					]
				}
			],
			{
				type: 'draw_picture',
				description: 'Draw a microscope.',
				parameters: ['microscope', 0.7],
				delay: 1800
			},
			{
				type: 'transcribe_audio',
				description: 'Explain a scientific concept that you find interesting for 30 seconds.',
				parameters: ['Explain a scientific concept that you find interesting.', 0.7, 30],
				delay: 2400
			},
			{
				type: 'article_quiz',
				description: 'Read an article about learning and complete the quiz with a perfect score.',
				parameters: ['LEARNING', 1.0],
				delay: 3600
			}
		],
		reward: 350,
		permissions: ['location']
	},
	{
		id: 'computer_whiz',
		title: 'Computer Whiz',
		description:
			'Show off your computer skills by completing these fun and creative challenges using technology!',
		icon: 'mdi:laptop',
		premium: true,
		rarity: 'rare',
		steps: [
			{
				type: 'article_quiz',
				description:
					'Read an article about technology and complete the quiz with at least 80% accuracy.',
				parameters: ['TECHNOLOGY', 0.8]
			},
			[
				{
					type: 'draw_picture',
					description: 'Draw a computer.',
					parameters: ['computer', 0.7]
				},
				{
					type: 'draw_picture',
					description: 'Draw a smartphone.',
					parameters: ['smartphone', 0.7]
				},
				{
					type: 'draw_picture',
					description: 'Draw a tablet.',
					parameters: ['tablet', 0.7]
				}
			],
			{
				type: 'take_photo_objects',
				description: 'Take a photo of a laptop and cell phone together.',
				parameters: [
					['laptop', 0.7],
					['cell_phone', 0.7]
				],
				delay: 1200
			},
			{
				type: 'order_items',
				description: 'Order these programming languages from oldest to newest.',
				parameters: [['Assembly', 'Fortran', 'C', 'C++', 'Python', 'Java', 'JavaScript']],
				delay: 1500
			},
			{
				type: 'match_terms',
				description: 'Match the technology term to its definition.',
				parameters: [
					'Match the technology term to its definition.',
					[
						['Algorithm', 'A set of instructions for solving a problem or performing a task.'],
						['Cloud Computing', 'The delivery of computing services over the internet.'],
						['Artificial Intelligence', 'The simulation of human intelligence in machines.'],
						['Machine Learning', 'A subset of AI that allows machines to learn from data.'],
						[
							'Blockchain',
							'A decentralized digital ledger that records transactions across many computers.'
						],
						['Internet of Things', 'The interconnection of everyday objects via the internet.'],
						[
							'Virtual Reality',
							'A simulated experience that can be similar to or completely different from the real world.'
						],
						[
							'Augmented Reality',
							'An interactive experience where digital content is overlaid on the real world.'
						],
						[
							'Quantum Computing',
							'A type of computing that uses quantum bits to perform operations on data.'
						]
					]
				],
				reward: 25
			},
			[
				{
					type: 'draw_picture',
					description: 'Draw a robot.',
					parameters: ['robot', 0.7]
				},
				{
					type: 'article_quiz',
					description:
						'Read an article about technology and complete the quiz with a perfect score.',
					parameters: ['TECHNOLOGY', 1.0],
					reward: 50
				}
			],
			{
				type: 'transcribe_audio',
				description: 'Describe your favorite piece of technology for 30 seconds.',
				parameters: ['Describe your favorite piece of technology.', 0.7, 30],
				delay: 1800
			}
		],
		reward: 450,
		permissions: ['camera']
	},
	{
		id: 'turning_season',
		title: 'The Turning Season',
		description: 'The season is changing whether you watch it or not. Catch it in the act.',
		icon: 'mdi:leaf-maple',
		rarity: 'rare',
		steps: [
			{
				type: 'take_photo_validation',
				description: 'Take a photo of one sign that the season is changing.',
				parameters: [
					'a visible sign of the season changing, such as buds, fallen leaves, frost, or new growth',
					0.5
				]
			},
			[
				{
					type: 'match_terms',
					description: 'Match each season to a change it brings.',
					parameters: [
						'Match each season to a change it brings to the land.',
						[
							['Spring', 'Buds open and migrants return'],
							['Summer', 'Long light and a full canopy'],
							['Autumn', 'Leaves color and seeds fall'],
							['Winter', 'Bare branches and dormant ground']
						]
					]
				},
				{
					type: 'order_items',
					description: 'Order these spring arrivals from earliest to latest.',
					parameters: [['snowdrops', 'crocus', 'daffodils', 'cherry blossom', 'tulips']],
					reward: 40
				}
			],
			{
				type: 'article_quiz',
				description:
					'Read an article about nature and complete the quiz with at least 80% accuracy.',
				parameters: ['NATURE', 0.8],
				delay: 600
			},
			{
				type: 'describe_text',
				description: 'Describe the season where you are, as if to someone far away.',
				parameters: [
					[
						{
							id: 'specificity',
							weight: 0.5,
							ideal: 'The response describes concrete, local signs of the season with real detail.'
						},
						{
							id: 'voice',
							weight: 0.5,
							ideal: "The response is warm and in the writer's own words, not generic."
						}
					],
					0.6,
					60,
					400
				],
				delay: 900
			},
			{
				type: 'draw_picture',
				description: 'Draw a single tree as it looks this season.',
				parameters: ['a tree as it appears in the current season', 0.6]
			}
		],
		reward: 350,
		permissions: ['camera']
	},
	{
		id: 'dawn_chorus',
		title: 'The Dawn Chorus',
		description:
			'Just before sunrise, birds hold the loudest meeting of the day. Set an early alarm and eavesdrop.',
		icon: 'mdi:bird',
		rarity: 'rare',
		steps: [
			{
				type: 'transcribe_audio',
				description: 'Go outside near dawn and describe the sounds you hear for 30 seconds.',
				parameters: ['Describe the sounds you hear outside near dawn.', 0.65, 30]
			},
			[
				{
					type: 'match_terms',
					description: 'Match each bird to its sound.',
					parameters: [
						'Match each bird to the sound it is known for.',
						[
							['Owl', 'A low hoot after dark'],
							['Woodpecker', 'A rapid drumming on wood'],
							['Rooster', 'A crow at first light'],
							['Dove', 'A soft repeated coo'],
							['Crow', 'A harsh caw']
						]
					]
				},
				{
					type: 'respond_to_prompt',
					description: 'Respond to a prompt about birds.',
					parameters: ['birds'],
					reward: 40
				}
			],
			{
				type: 'article_quiz',
				description:
					'Read an article about nature and complete the quiz with at least 75% accuracy.',
				parameters: ['NATURE', 0.75],
				delay: 600
			},
			{
				type: 'take_photo_validation',
				description: 'Take a photo of a bird, or a place a bird would sing from.',
				parameters: [
					'a bird, or a perch such as a branch, wire, or rooftop where a bird would sing',
					0.45
				],
				delay: 900
			},
			{
				type: 'transcribe_audio',
				description: 'Describe which sound you would most want to wake up to for 30 seconds.',
				parameters: ['Describe which morning sound you would most want to wake up to.', 0.65, 30]
			}
		],
		reward: 375,
		permissions: ['camera', 'record']
	},
	{
		id: 'garden_keeper',
		title: 'Garden Keeper',
		description:
			'A garden is a slow conversation with the ground. Learn its language and tend a small patch of it.',
		icon: 'mdi:flower-tulip',
		rarity: 'rare',
		steps: [
			{
				type: 'take_photo_validation',
				description: 'Take a photo of a garden, a planter, or a single potted plant.',
				parameters: ['a garden bed, planter, or potted plant', 0.5]
			},
			{
				type: 'order_items',
				description: 'Order these steps of growing a plant from first to last.',
				parameters: [
					[
						'prepare the soil',
						'plant the seed',
						'water it',
						'watch it sprout',
						'tend it as it grows',
						'harvest or bloom'
					]
				],
				reward: 40
			},
			[
				{
					type: 'article_quiz',
					description:
						'Read an article about home improvement and complete the quiz with at least 75% accuracy.',
					parameters: ['HOME_IMPROVEMENT', 0.75]
				},
				{
					type: 'article_quiz',
					description:
						'Read an article about a personal goal and complete the quiz with at least 75% accuracy.',
					parameters: ['PERSONAL_GOAL', 0.75],
					reward: 40
				}
			],
			{
				type: 'describe_text',
				description: 'Describe something you would like to grow, and why.',
				parameters: [
					[
						{
							id: 'intention',
							weight: 0.5,
							ideal:
								'The response names something specific the writer wants to grow and a genuine reason.'
						},
						{
							id: 'voice',
							weight: 0.5,
							ideal: "The response is personal and in the writer's own words."
						}
					],
					0.55,
					40
				],
				delay: 600
			},
			{
				type: 'draw_picture',
				description: 'Draw the garden you would like to tend.',
				parameters: ['a small garden with plants and flowers', 0.6]
			}
		],
		reward: 325,
		permissions: ['camera']
	},
	{
		id: 'color_field',
		title: 'Color Field',
		description: 'Pick one color and let it lead you outside. You will start seeing it everywhere.',
		icon: 'mdi:palette-outline',
		rarity: 'rare',
		steps: [
			{
				type: 'take_photo_validation',
				description:
					'Choose a color, then take a photo of something outdoors that wears it boldly.',
				parameters: ['an outdoor subject dominated by a single strong color', 0.45]
			},
			{
				type: 'take_photo_list',
				description: 'Take photos of three more things in your chosen color.',
				parameters: [['a flower', 'a leaf or plant', 'a human-made object'], 0.5],
				reward: 50
			},
			[
				{
					type: 'match_terms',
					description: 'Match each color to something in nature known for it.',
					parameters: [
						'Match each color to a natural thing known for it.',
						[
							['Red', 'A cardinal or a ripe berry'],
							['Orange', 'Autumn leaves or a monarch'],
							['Yellow', 'A sunflower or a finch'],
							['Green', 'Moss or new leaves'],
							['Blue', 'A jay or a clear sky']
						]
					]
				},
				{
					type: 'draw_picture',
					description: 'Draw a scene using mostly your chosen color.',
					parameters: ['a scene dominated by a single color', 0.55],
					reward: 50
				}
			],
			{
				type: 'article_quiz',
				description: 'Read an article about art and complete the quiz with at least 80% accuracy.',
				parameters: ['ART', 0.8],
				delay: 600
			},
			{
				type: 'take_photo_caption',
				description: 'Take one photo that captures the mood of your color.',
				parameters: [
					[
						{
							id: 'mood',
							weight: 0.5,
							ideal: 'The photo and caption convey a clear mood tied to the chosen color.'
						},
						{
							id: 'composition',
							weight: 0.3,
							ideal: 'The photo is thoughtfully composed around the color.'
						},
						{
							id: 'originality',
							weight: 0.2,
							ideal: 'The photo shows an original way of seeing the color.'
						}
					],
					'Take one photo that captures the mood of your color.',
					0.55
				]
			}
		],
		reward: 400,
		permissions: ['camera']
	},
	{
		id: 'night_sky_novice',
		title: 'Night Sky Novice',
		description:
			'The stars have not gone anywhere. Give your eyes twenty dark minutes and the sky fills back in.',
		icon: 'mdi:star-four-points',
		rarity: 'rare',
		steps: [
			{
				type: 'take_photo_validation',
				description: 'Go outside after dark and take a photo of the night sky.',
				parameters: ['the night sky after dark, showing sky, stars, or the moon', 0.4]
			},
			[
				{
					type: 'order_items',
					description: 'Order these night-sky objects from nearest to farthest from Earth.',
					parameters: [
						['the Moon', 'the Sun', 'Jupiter', 'the nearest star', 'the Andromeda galaxy']
					],
					reward: 50
				},
				{
					type: 'match_terms',
					description: 'Match each night-sky sight to what it is.',
					parameters: [
						'Match each night-sky sight to what it is.',
						[
							['Shooting star', 'A tiny grain of dust burning up'],
							['The Moon', 'A world reflecting the Sun'],
							['A planet', 'A steady, non-twinkling light'],
							['The Milky Way', 'The edge-on view of our galaxy'],
							['A satellite', 'A moving human-made light']
						]
					],
					reward: 50
				}
			],
			{
				type: 'article_quiz',
				description:
					'Read an article about learning and complete the quiz with at least 80% accuracy.',
				parameters: ['LEARNING', 0.8],
				delay: 600
			},
			{
				type: 'transcribe_audio',
				description: 'Describe what it felt like to look up for 30 seconds.',
				parameters: ['Describe what it felt like to look up at the night sky.', 0.65, 30]
			},
			{
				type: 'draw_picture',
				description: 'Draw the night sky as you saw it, or wish you could.',
				parameters: ['a night sky with stars and the moon', 0.6]
			}
		],
		reward: 375,
		permissions: ['camera', 'record']
	},
	{
		id: 'counting_the_good',
		title: 'Counting the Good',
		description:
			'Attention is a form of thanks. Spend a little of yours on the ordinary things that go right.',
		icon: 'mdi:hand-heart',
		premium: true,
		rarity: 'rare',
		steps: [
			{
				type: 'describe_text',
				description: 'Name three ordinary things you are glad exist today.',
				parameters: [
					[
						{
							id: 'specificity',
							weight: 0.5,
							ideal:
								'The response names three concrete, ordinary things rather than vague generalities.'
						},
						{
							id: 'sincerity',
							weight: 0.5,
							ideal: 'The response reads as genuine and personal.'
						}
					],
					0.55,
					30
				]
			},
			{
				type: 'take_photo_validation',
				description: 'Take a photo of one small thing you are grateful for.',
				parameters: ['an ordinary object or scene the person is grateful for', 0.4],
				reward: 40
			},
			[
				{
					type: 'respond_to_prompt',
					description: 'Respond to a prompt about gratitude.',
					parameters: ['gratitude']
				},
				{
					type: 'article_quiz',
					description:
						'Read an article about spirituality and complete the quiz with at least 75% accuracy.',
					parameters: ['SPIRITUALITY', 0.75],
					reward: 50
				},
				{
					type: 'trailmarker_added',
					description: 'Leave a trailmark note of thanks for the next visitor.',
					parameters: [],
					reward: 50
				}
			],
			{
				type: 'transcribe_audio',
				description: 'Thank someone out loud, even if they cannot hear it, for 30 seconds.',
				parameters: ['Thank someone out loud for something they did.', 0.65, 30],
				delay: 600
			},
			{
				type: 'describe_text',
				description: 'Write one line you want to remember from today.',
				parameters: [
					[
						{
							id: 'meaning',
							weight: 0.6,
							ideal: 'The line captures something meaningful from the day with specificity.'
						},
						{
							id: 'voice',
							weight: 0.4,
							ideal: "The line is in the writer's own voice."
						}
					],
					0.5,
					15,
					200
				]
			}
		],
		reward: 300,
		permissions: ['camera', 'record']
	},
	// #region amazing quests
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
	{
		id: 'city_explorer',
		title: 'City Explorer',
		description:
			'Discover interesting landmarks and attractions in your city by taking photos of them!',
		icon: 'mdi:city-variant',
		rarity: 'amazing',
		steps: [
			{
				type: 'take_photo_caption',
				description: 'Take a photo that represents the concept of "community".',
				parameters: [
					[
						{
							id: 'togetherness',
							ideal:
								'The caption demonstrates a strong sense of togetherness and connection among people.',
							weight: 0.4
						},
						{
							id: 'diversity',
							ideal:
								'The caption reflects the diversity and inclusivity of the community, showcasing different cultures, backgrounds, or perspectives.',
							weight: 0.3
						},
						{
							id: 'support',
							ideal:
								'The caption conveys a sense of support and care within the community, highlighting acts of kindness, collaboration, or mutual aid.',
							weight: 0.3
						}
					],
					'Take a photo that represents the concept of "community".',
					0.6
				]
			},
			{
				type: 'order_items',
				description: 'Order these modes of transportation from slowest to fastest.',
				parameters: [['Bicycle', 'Car', 'Bus', 'Train', 'Airplane']],
				delay: 3600
			},
			{
				type: 'take_photo_classification',
				description: 'Take a photo of a car wheel.',
				parameters: ['car_wheel', 0.7],
				delay: 1200
			},
			[
				{
					type: 'order_items',
					description: 'Order these major US cities from west to east.',
					parameters: [
						[
							'San Francisco',
							'Seattle',
							'Los Angeles',
							'Las Vegas',
							'Salt Lake City',
							'Denver',
							'Houston',
							'Chicago',
							'Miami',
							'New York City',
							'Boston'
						]
					],
					reward: 75
				},
				{
					type: 'match_terms',
					description: 'Match the US city to its state.',
					parameters: [
						'Match the US city to its state.',
						[
							['Seattle', 'Washington'],
							['San Francisco', 'California'],
							['Las Vegas', 'Nevada'],
							['Denver', 'Colorado'],
							['Houston', 'Texas'],
							['Chicago', 'Illinois'],
							['New York City', 'New York'],
							['Boston', 'Massachusetts'],
							['Salt Lake City', 'Utah'],
							['Miami', 'Florida']
						]
					],
					reward: 75
				}
			],
			{
				type: 'article_quiz',
				description:
					'Read an article about travel and complete the quiz with at least 80% accuracy.',
				parameters: ['TRAVEL', 0.8],
				delay: 1800
			},
			{
				type: 'draw_picture',
				description: 'Draw a city bus.',
				parameters: ['city bus', 0.7],
				delay: 2400
			},
			{
				type: 'article_quiz',
				description: 'Read an article about finance and complete the quiz with 100% accuracy.',
				parameters: ['FINANCE', 1.0],
				delay: 3000
			}
		],
		reward: 550,
		permissions: ['camera']
	},
	{
		id: 'nature_lover',
		title: 'Nature Lover',
		description: 'Learn about the nature around you and how to take care of it!',
		icon: 'mdi:tree-outline',
		rarity: 'amazing',
		steps: [
			{
				type: 'order_items',
				description: 'Order these types of trees from tallest to shortest.',
				parameters: [
					['Redwood', 'Oak', 'Birch', 'Maple', 'Pine', 'Cedar', 'Willow', 'Spruce', 'Aspen']
				]
			},
			[
				{
					type: 'take_photo_validation',
					description: 'Take a photo of a tree.',
					parameters: ['a tree', 0.6],
					delay: 1200
				},
				{
					type: 'submit_event_image',
					description: 'Submit a photo at a Nature event with at least a C grade.',
					parameters: [{ type: 'activity_type', value: 'NATURE' }, 0.7]
				}
			],
			{
				type: 'article_quiz',
				description:
					'Read an article about nature and complete the quiz with at least 80% accuracy.',
				parameters: ['NATURE', 0.8],
				delay: 1800,
				reward: 75
			},
			{
				type: 'activity_read_time',
				description: 'Read for at least 10 minutes on an Activity about Nature.',
				parameters: [{ type: 'activity_type', value: 'NATURE' }, 10 * 60],
				delay: 3600
			},
			[
				{
					type: 'respond_to_prompt',
					description: 'Respond to a prompt with the word "nature" in it.',
					parameters: ['nature'],
					reward: 100
				},
				{
					type: 'transcribe_audio',
					description: 'Describe how nature makes you feel.',
					reward: 100
				}
			],
			{
				type: 'match_terms',
				description: 'Match the type of tree to its characteristics.',
				parameters: [
					'Match the plant with its native country or region.',
					[
						['Wheat', 'Middle East'],
						['Rice', 'Asia'],
						['Corn', 'North America'],
						['Barley', 'Europe'],
						['Rye', 'Europe'],
						['Oak', 'North America'],
						['Basil', 'Mediterranean'],
						['Ivy', 'Temperate Forests'],
						['Fern', 'Temperate Forests'],
						['Redwood', 'North America'],
						['Pine', 'North America'],
						['Spruce', 'North America'],
						['Aspen', 'North America'],
						['Birch', 'North America']
					]
				],
				reward: 125
			},
			{
				type: 'article_quiz',
				description:
					'Read an article about nature and complete the quiz with at least 100% accuracy.',
				parameters: ['NATURE', 1.0],
				delay: 1800
			}
		],
		reward: 1300,
		permissions: ['camera', 'location']
	},
	{
		id: 'wonder_collector',
		title: 'The Wonder Collector',
		description:
			"Curiosity is a muscle. Spend a week finding things that make you say 'wait, really?'",
		icon: 'mdi:telescope',
		rarity: 'amazing',
		steps: [
			{
				type: 'take_photo_validation',
				description: 'Take a photo of something outdoors that made you curious.',
				parameters: ['an outdoor subject that sparks curiosity or a question', 0.45]
			},
			[
				{
					type: 'article_quiz',
					description:
						'Read an article about nature and complete the quiz with at least 80% accuracy.',
					parameters: ['NATURE', 0.8]
				},
				{
					type: 'article_quiz',
					description:
						'Read an article about technology and complete the quiz with at least 80% accuracy.',
					parameters: ['TECHNOLOGY', 0.8],
					reward: 50
				},
				{
					type: 'article_quiz',
					description:
						'Read an article about learning and complete the quiz with at least 80% accuracy.',
					parameters: ['LEARNING', 0.8],
					reward: 50
				}
			],
			{
				type: 'describe_text',
				description: 'Write down a question you cannot stop wondering about.',
				parameters: [
					[
						{
							id: 'genuine_curiosity',
							weight: 0.6,
							ideal: 'The response poses a real, specific question the writer is curious about.'
						},
						{
							id: 'depth',
							weight: 0.4,
							ideal: 'The question shows thought rather than a throwaway line.'
						}
					],
					0.55,
					25
				],
				delay: 600
			},
			{
				type: 'match_terms',
				description: 'Match each everyday wonder to why it happens.',
				parameters: [
					'Match each everyday wonder to its cause.',
					[
						['Rainbow', 'Sunlight split by raindrops'],
						['Thunder', 'Air snapping back after lightning'],
						['Tides', 'The Moon pulling the oceans'],
						['Sunset colors', 'Blue light scattered away by the air'],
						['Frost', 'Water vapor freezing straight onto surfaces']
					]
				],
				reward: 50
			},
			{
				type: 'article_read_time',
				description: 'Spend at least 10 minutes reading about learning.',
				parameters: ['LEARNING', 10 * 60],
				delay: 1200
			},
			{
				type: 'draw_picture',
				description: 'Draw the thing you were most curious about this week.',
				parameters: ['something that made you curious', 0.55]
			}
		],
		reward: 600,
		permissions: ['camera']
	},
	{
		id: 'four_elements',
		title: 'The Four Elements',
		description:
			'Earth, water, air, fire. The old way of naming the world still holds a surprising amount of truth.',
		icon: 'mdi:earth',
		rarity: 'amazing',
		steps: [
			{
				type: 'take_photo_validation',
				description: 'Earth: take a photo of soil, stone, or the ground itself.',
				parameters: ['bare earth, soil, rock, or stony ground', 0.5]
			},
			[
				{
					type: 'take_photo_validation',
					description: 'Water: take a photo of water in any form.',
					parameters: ['water in any form', 0.45],
					reward: 40
				},
				{
					type: 'take_photo_validation',
					description: 'Air: take a photo of something being moved by the wind.',
					parameters: ['something being moved by wind, such as leaves, a flag, or clouds', 0.45],
					reward: 40
				}
			],
			{
				type: 'take_photo_validation',
				description:
					'Fire: take a photo of a flame or a warm glow (a candle, a lamp, or the low sun).',
				parameters: ['a flame, warm light, or the low sun', 0.45],
				delay: 600
			},
			{
				type: 'match_terms',
				description: 'Match each element to what it gives life.',
				parameters: [
					'Match each classical element to what it gives life.',
					[
						['Earth', 'Nutrients and a place to root'],
						['Water', 'The medium every cell needs'],
						['Air', 'Oxygen and carbon dioxide'],
						['Fire', 'Warmth and, through the Sun, all energy']
					]
				],
				reward: 50
			},
			{
				type: 'article_quiz',
				description:
					'Read an article about nature and complete the quiz with at least 85% accuracy.',
				parameters: ['NATURE', 0.85],
				delay: 1200
			},
			{
				type: 'draw_picture',
				description: 'Draw a single scene that holds all four elements.',
				parameters: ['a landscape containing earth, water, air, and fire', 0.55]
			}
		],
		reward: 650,
		permissions: ['camera']
	},
	{
		id: 'long_look',
		title: 'The Long Look',
		description:
			'Almost nothing is boring once you look at it long enough. Prove it to yourself, one patient subject at a time.',
		icon: 'mdi:eye-outline',
		rarity: 'amazing',
		steps: [
			{
				type: 'take_photo_validation',
				description: 'Pick one living thing and take a photo of it to begin your watch.',
				parameters: ['a single living thing such as a plant, insect, or bird', 0.45]
			},
			{
				type: 'describe_text',
				description:
					'Watch it for several minutes, then describe something it did that you would have missed.',
				parameters: [
					[
						{
							id: 'observation',
							weight: 0.6,
							ideal:
								'The response describes a specific behavior or detail noticed only through patient watching.'
						},
						{
							id: 'patience',
							weight: 0.4,
							ideal: 'The response reflects genuine sustained attention rather than a glance.'
						}
					],
					0.6,
					50
				],
				delay: 300,
				reward: 60
			},
			[
				{
					type: 'activity_read_time',
					description: 'Spend at least 10 minutes with an Activity about Nature.',
					parameters: [{ type: 'activity_type', value: 'NATURE' }, 10 * 60]
				},
				{
					type: 'article_read_time',
					description: 'Spend at least 10 minutes reading about relaxation.',
					parameters: ['RELAXATION', 10 * 60],
					reward: 50
				},
				{
					type: 'nature_minutes',
					description: 'Spend at least 15 minutes outside watching one thing.',
					parameters: [15],
					reward: 50
				}
			],
			{
				type: 'transcribe_audio',
				description: 'Describe what patience felt like out there for 45 seconds.',
				parameters: ['Describe what it felt like to watch one thing patiently.', 0.65, 45],
				delay: 900
			},
			{
				type: 'take_photo_caption',
				description: 'Take one final photo of your subject and say what changed while you watched.',
				parameters: [
					[
						{
							id: 'change',
							weight: 0.5,
							ideal: 'The caption names what changed in the subject over the watching period.'
						},
						{
							id: 'attention',
							weight: 0.5,
							ideal: 'The caption reflects careful, sustained attention.'
						}
					],
					'Photograph your subject and say what changed while you watched.',
					0.55
				]
			}
		],
		reward: 550,
		permissions: ['camera', 'record']
	},
	{
		id: 'mapmaker',
		title: 'Mapmaker of Small Places',
		description:
			'Cartographers mapped the whole world. Map the fifty steps outside your door instead - no one knows them better than you could.',
		icon: 'mdi:map-marker-path',
		premium: true,
		rarity: 'amazing',
		steps: [
			{
				type: 'take_photo_validation',
				description: 'Take a photo of a landmark on your daily path that only you would notice.',
				parameters: ['a small personal landmark along an everyday route', 0.45]
			},
			{
				type: 'take_photo_list',
				description: 'Photograph three features you would put on your map.',
				parameters: [['a tree or plant', 'a path or road', 'a building or structure'], 0.5],
				reward: 50
			},
			[
				{
					type: 'order_items',
					description: 'Order these map scales from smallest area to largest.',
					parameters: [
						['a room', 'a building', 'a street', 'a neighborhood', 'a city', 'a country']
					],
					reward: 50
				},
				{
					type: 'match_terms',
					description: 'Match each map symbol to what it means.',
					parameters: [
						'Match each common map symbol to what it represents.',
						[
							['Blue line', 'A river or stream'],
							['Green patch', 'Woods or a park'],
							['Brown contour', 'A change in elevation'],
							['Dashed line', 'A footpath or trail'],
							['Star', 'A capital or point of interest']
						]
					],
					reward: 50
				},
				{
					type: 'trailmarker_added',
					description: 'Leave a trailmark note at a spot on your map.',
					parameters: [],
					reward: 50
				}
			],
			{
				type: 'draw_picture',
				description: 'Draw a map of the small place you know best.',
				parameters: ['a hand-drawn map of a small local area', 0.55],
				delay: 600
			},
			{
				type: 'article_quiz',
				description:
					'Read an article about travel and complete the quiz with at least 80% accuracy.',
				parameters: ['TRAVEL', 0.8],
				delay: 1200
			},
			{
				type: 'describe_text',
				description: 'Describe the route you would give a friend to your favorite nearby spot.',
				parameters: [
					[
						{
							id: 'clarity',
							weight: 0.5,
							ideal: 'The directions are clear and specific enough to actually follow.'
						},
						{
							id: 'character',
							weight: 0.5,
							ideal: 'The description conveys what makes the spot worth visiting.'
						}
					],
					0.55,
					40
				]
			}
		],
		reward: 600,
		permissions: ['camera']
	},
	{
		id: 'keeper_of_seasons',
		title: 'Keeper of Seasons',
		description:
			'Cultures everywhere mark the year with the land. Step into one turning of the season with other people.',
		icon: 'mdi:calendar-heart',
		rarity: 'amazing',
		steps: [
			{
				type: 'take_photo_validation',
				description: 'Take a photo of something that marks the time of year where you live.',
				parameters: [
					'a seasonal marker such as decorations, produce, weather, or plants of the season',
					0.45
				]
			},
			[
				{
					type: 'attend_event',
					description: 'Attend a holiday event with at least 20 attendees.',
					parameters: [{ type: 'activity_type', value: 'HOLIDAY' }, 20],
					reward: 75
				},
				{
					type: 'attend_event',
					description: 'Attend a community service event with at least 15 attendees.',
					parameters: [{ type: 'activity_type', value: 'COMMUNITY_SERVICE' }, 15],
					reward: 75
				},
				{
					type: 'attend_event',
					description: 'Attend a family event with at least 10 attendees.',
					parameters: [{ type: 'activity_type', value: 'FAMILY' }, 10],
					reward: 75
				},
				{
					type: 'trailmarker_added',
					description: 'Leave a trailmark note where you marked the season.',
					parameters: [],
					reward: 75
				}
			],
			{
				type: 'article_quiz',
				description:
					'Read an article about holidays and complete the quiz with at least 80% accuracy.',
				parameters: ['HOLIDAY', 0.8],
				delay: 600
			},
			{
				type: 'match_terms',
				description: 'Match each season to a celebration tied to it.',
				parameters: [
					'Match each season to a kind of celebration tied to it.',
					[
						['Spring', 'Planting and renewal festivals'],
						['Summer', 'Solstice and midsummer gatherings'],
						['Autumn', 'Harvest festivals'],
						['Winter', 'Festivals of light in the dark months']
					]
				],
				reward: 50
			},
			{
				type: 'describe_text',
				description: 'Describe a seasonal tradition that means something to you.',
				parameters: [
					[
						{
							id: 'personal',
							weight: 0.5,
							ideal: 'The response describes a specific tradition personal to the writer.'
						},
						{
							id: 'meaning',
							weight: 0.5,
							ideal: 'The response conveys why it matters to them.'
						}
					],
					0.55,
					50
				],
				delay: 1200
			}
		],
		reward: 525,
		permissions: ['camera', 'location']
	},
	// #region green quests
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
	},
	{
		id: 'nature_lover',
		title: 'Nature Lover',
		description: 'Learn about the nature around you and how to take care of it!',
		icon: 'mdi:flower',
		premium: true,
		rarity: 'green',
		steps: [
			{
				type: 'article_quiz',
				description: 'Read an article about spirituality and complete the quiz with 100% accuracy.',
				parameters: ['SPIRITUALITY', 1.0]
			},
			[
				{
					type: 'take_photo_location',
					description: 'Take a photo at Yellowstone National Park.',
					parameters: [44.428, -110.5885, 30000],
					delay: 1200,
					reward: 250
				},
				{
					type: 'take_photo_location',
					description: 'Take a photo at Yosemite National Park.',
					parameters: [37.8651, -119.5383, 5000],
					delay: 2400,
					reward: 250
				}
			],
			{
				type: 'draw_picture',
				description: 'Draw a pine tree.',
				parameters: ['pine tree', 0.7],
				delay: 3600,
				reward: 100
			},
			{
				type: 'attend_event',
				description: 'Attend a nature-related event with at least 20 attendees.',
				parameters: [{ type: 'activity_type', value: 'NATURE' }, 20],
				delay: 4800
			},
			{
				type: 'article_quiz',
				description: 'Read an article about pets and complete the quiz with 100% accuracy.',
				parameters: ['PETS', 1.0],
				reward: 150
			},
			[
				{
					type: 'order_items',
					description: 'Order these plants from earliest to most recent origin on Earth.',
					parameters: [
						[
							'liverworts',
							'mosses',
							'lycophytes',
							'horsetails',
							'ferns',
							'conifers',
							'cycads',
							'ginkgo',
							'angiosperms',
							'grasses'
						]
					],
					reward: 100
				},
				{
					type: 'match_terms',
					description: 'Match the plant to its description.',
					parameters: [
						'Match the plant to its description.',
						[
							[
								'liverworts',
								'Early non-vascular land plants with flattened, leaf-like body structures.'
							],
							[
								'mosses',
								'Small non-vascular plants that typically grow in dense green mats in moist habitats.'
							],
							[
								'lycophytes',
								'Early vascular plants including clubmosses that reproduce via spores.'
							],
							[
								'horsetails',
								'Vascular plants that have hollow, jointed stems and reproduce via spores.'
							],
							['ferns', 'Vascular plants that have feathery fronds and reproduce via spores.'],
							['conifers', 'Cone-bearing seed plants such as pines, firs, and spruces.'],
							['cycads', 'Ancient gymnosperms with stout trunks and crown-like leaves.'],
							['ginkgo', 'A gymnosperm lineage represented today by Ginkgo biloba.'],
							['angiosperms', 'Flowering plants that produce seeds enclosed in fruits.'],
							[
								'grasses',
								'A flowering plant family that includes major cereal crops and many turf species.'
							]
						]
					],
					reward: 100
				}
			],
			{
				type: 'describe_text',
				description: 'Describe your favorite nature spot in at least 100 words.',
				parameters: ['Describe your favorite nature spot in at least 100 words.', 0.7, 100],
				delay: 6000,
				reward: 150
			}
		],
		reward: 2500,
		permissions: ['camera']
	},
	{
		id: 'hundred_acre_habit',
		title: 'The Hundred-Acre Habit',
		description:
			'One visit to a wild place is a nice afternoon. Ten visits is a relationship. Begin one.',
		icon: 'mdi:forest',
		rarity: 'green',
		steps: [
			{
				type: 'take_photo_validation',
				description: 'Take a photo at a green space near you: a park, wood, field, or shoreline.',
				parameters: ['a natural green space such as a park, woods, field, or shoreline', 0.5]
			},
			{
				type: 'take_photo_list',
				description: 'Photograph three living things sharing that place.',
				parameters: [['a tree', 'a smaller plant', 'an animal or insect'], 0.5],
				reward: 50
			},
			[
				{
					type: 'activity_read_time',
					description: 'Spend at least 15 minutes with an Activity about Nature.',
					parameters: [{ type: 'activity_type', value: 'NATURE' }, 15 * 60],
					reward: 50
				},
				{
					type: 'article_read_time',
					description: 'Read about nature for at least 15 minutes.',
					parameters: ['NATURE', 15 * 60],
					reward: 50
				},
				{
					type: 'nature_minutes',
					description: 'Spend at least 20 minutes outside in your green space.',
					parameters: [20],
					reward: 50
				}
			],
			{
				type: 'article_quiz',
				description:
					'Read an article about nature and complete the quiz with at least 85% accuracy.',
				parameters: ['NATURE', 0.85],
				delay: 3600
			},
			{
				type: 'describe_text',
				description: 'Describe how the place changed between two of your visits.',
				parameters: [
					[
						{
							id: 'observation',
							weight: 0.5,
							ideal: 'The response describes a specific change observed across visits.'
						},
						{
							id: 'connection',
							weight: 0.5,
							ideal: 'The response conveys a growing familiarity with the place.'
						}
					],
					0.6,
					60,
					500
				],
				delay: 7200
			},
			{
				type: 'draw_picture',
				description: 'Draw the place from memory, the way you carry it now.',
				parameters: ['a remembered natural landscape', 0.55]
			}
		],
		reward: 800,
		permissions: ['camera']
	},
	{
		id: 'still_water',
		title: 'Still Water',
		description:
			'Find moving water and give it an unhurried hour. People have gone to water to think for as long as there have been people.',
		icon: 'mdi:waves-arrow-up',
		premium: true,
		rarity: 'green',
		steps: [
			{
				type: 'take_photo_validation',
				description: 'Take a photo beside moving water - a stream, river, lake edge, or fountain.',
				parameters: ['moving or open water such as a stream, river, lake edge, or fountain', 0.5]
			},
			{
				type: 'transcribe_audio',
				description: 'Describe the sound of the water where you sit for 30 seconds.',
				parameters: ['Describe the sound of the water where you are sitting.', 0.6, 30],
				reward: 50
			},
			[
				{
					type: 'respond_to_prompt',
					description: 'Respond to a prompt about water.',
					parameters: ['water']
				},
				{
					type: 'article_quiz',
					description:
						'Read an article about relaxation and complete the quiz with at least 80% accuracy.',
					parameters: ['RELAXATION', 0.8],
					reward: 50
				},
				{
					type: 'nature_minutes',
					description: 'Spend at least 20 minutes outside beside the water.',
					parameters: [20],
					reward: 50
				}
			],
			{
				type: 'describe_text',
				description: 'Sit for a while, then describe what the water carried off while you watched.',
				parameters: [
					[
						{
							id: 'reflection',
							weight: 0.6,
							ideal:
								'The response reflects genuinely on thoughts that settled while watching the water.'
						},
						{
							id: 'presence',
							weight: 0.4,
							ideal: 'The response shows the writer actually spent unhurried time there.'
						}
					],
					0.6,
					60,
					500
				],
				delay: 900
			},
			{
				type: 'draw_picture',
				description: 'Draw the surface of the water as it moved.',
				parameters: ['the moving surface of water', 0.55]
			}
		],
		reward: 850,
		permissions: ['camera', 'record']
	},
	{
		id: 'year_of_noticing',
		title: 'A Year of Noticing',
		description:
			'The reward for paying attention is a life that feels longer, because you were actually in it. Start the practice that lasts.',
		icon: 'mdi:calendar-star',
		rarity: 'green',
		steps: [
			{
				type: 'describe_text',
				description: 'Write what you hope to notice more of this year.',
				parameters: [
					[
						{
							id: 'intention',
							weight: 0.5,
							ideal: 'The response names something specific the writer wants to pay attention to.'
						},
						{
							id: 'voice',
							weight: 0.5,
							ideal: "The response is personal and in the writer's own words."
						}
					],
					0.55,
					40
				]
			},
			{
				type: 'take_photo_validation',
				description: 'Take a photo of the first thing today worth remembering.',
				parameters: ['a moment or subject worth remembering', 0.4],
				reward: 40
			},
			[
				{
					type: 'distance_covered',
					description: 'Take a mindful walk of at least one mile.',
					parameters: [1600],
					mobile_only: true,
					reward: 60
				},
				{
					type: 'article_read_time',
					description: 'Read about relaxation for at least 10 minutes.',
					parameters: ['RELAXATION', 10 * 60]
				},
				{
					type: 'nature_minutes',
					description: 'Spend at least 15 minutes outside noticing what you usually miss.',
					parameters: [15],
					reward: 60
				}
			],
			{
				type: 'article_quiz',
				description:
					'Read an article about a personal goal and complete the quiz with at least 80% accuracy.',
				parameters: ['PERSONAL_GOAL', 0.8],
				delay: 3600
			},
			[
				{
					type: 'respond_to_prompt',
					description: 'Respond to a prompt about slowing down.',
					parameters: ['slow']
				},
				{
					type: 'transcribe_audio',
					description: 'Describe one thing you noticed today that you usually miss for 30 seconds.',
					parameters: ['Describe one thing you noticed today that you usually miss.', 0.65, 30],
					reward: 50
				}
			],
			{
				type: 'describe_text',
				description: 'Describe the difference between looking and truly seeing, in your own words.',
				parameters: [
					[
						{
							id: 'insight',
							weight: 0.6,
							ideal: 'The response offers a genuine reflection on attention rather than a cliche.'
						},
						{
							id: 'voice',
							weight: 0.4,
							ideal: "The response is in the writer's own voice."
						}
					],
					0.6,
					50,
					500
				]
			}
		],
		reward: 1000,
		permissions: ['camera', 'record', 'motion']
	},
	{
		id: 'reader',
		title: 'Reader',
		description: 'Expand your knowledge by reading articles on a variety of topics!',
		icon: 'mdi:book-open',
		rarity: 'amazing',
		steps: [
			{
				type: 'article_quiz',
				description:
					'Read an article about studying and complete the quiz with at least 80% accuracy.',
				parameters: ['STUDY', 0.8]
			},
			{
				type: 'describe_text',
				description: 'Describe your favorite book in 100 words or less.',
				parameters: ['Describe your favorite book in 100 words or less.', 0.7],
				delay: 1200
			},
			[
				{
					type: 'order_items',
					description: 'Order these classic novels from earliest to most recent publication date.',
					parameters: [
						[
							'Pride and Prejudice',
							'Moby Dick',
							'The Great Gatsby',
							'1984',
							'To Kill a Mockingbird',
							'The Catcher in the Rye',
							'Lord of the Flies',
							'The Lord of the Rings',
							'The Hobbit',
							"Harry Potter and the Sorcerer's Stone"
						]
					],
					reward: 100
				},
				{
					type: 'draw_picture',
					description: 'Draw a picture of a book cover.',
					parameters: ['A picture of a book cover.', 0.6],
					reward: 50
				},
				{
					type: 'attend_event',
					description: 'Attend a project-related event with at least 20 attendees.',
					parameters: [{ type: 'activity_type', value: 'PROJECT' }, 20],
					reward: 100
				}
			],
			{
				type: 'take_photo_validation',
				description: 'Take a photo of a book cover.',
				parameters: ['A photo of a book cover.', 0.6],
				delay: 1500
			},
			[
				{
					type: 'match_terms',
					description: 'Match the author to their most famous work.',
					parameters: [
						'Match the author to their most famous work.',
						[
							['Jane Austen', 'Pride and Prejudice'],
							['Herman Melville', 'Moby Dick'],
							['George Orwell', '1984'],
							['J.D. Salinger', 'The Catcher in the Rye'],
							['Harper Lee', 'To Kill a Mockingbird']
						]
					],
					reward: 25
				},
				{
					type: 'article_quiz',
					description: 'Answer questions about learning with 100% accuracy.',
					parameters: ['LEARNING', 1.0],
					reward: 150
				}
			],
			{
				type: 'transcribe_audio',
				description: 'Describe your favorite author for 30 seconds.',
				parameters: ['Describe your favorite author.', 0.7, 30],
				delay: 1800
			}
		],
		reward: 350,
		permissions: ['camera']
	}
] as Quest[];

// snapshot built-in quest step hashes once at module load so the migration check
// on the hot read path is a free array compare against an in-memory map.
prewarmBuiltInHashes(quests);

export async function getAllQuests(kv: KVNamespace): Promise<(CustomQuest | Quest)[]> {
	const quests0 = [...quests];

	// add custom quests
	const customQuests = (await getCustomQuests(kv)).map(async (q) => await getCustomQuest(q.id, kv));

	return [...quests0, ...(await Promise.all(customQuests))].filter((q) => q != null);
}

export async function getQuest(
	id: string,
	bindings: Bindings,
	userId?: string
): Promise<CustomQuest | Quest | null> {
	const quest = quests.find((q) => q.id === id);
	if (quest) {
		return quest;
	}

	if (id.startsWith('activity_quest_')) {
		const activityId = id.replace('activity_quest_', '');
		const activity = await getActivity(activityId, bindings);
		if (!activity) return null;

		return designActivityQuest(activity);
	}

	if (id.startsWith(MASTERY_QUEST_ID_PREFIX)) {
		if (!userId) return null;
		const badgeId = masteryBadgeIdFromQuestId(id);
		if (!badgeId) return null;
		return await getMasteryQuest(userId, badgeId, bindings.KV);
	}

	return await getCustomQuest(id, bindings.KV);
}
