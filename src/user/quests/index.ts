import { ScoringCriterion } from '../../content/ferry';
import { ActivityType, ActivityOrType, Rarity } from '../../util/types';
import { designActivityQuest, getActivity } from './activity';
import { CustomQuest, getCustomQuest, getCustomQuests } from './custom';

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
	| {
			type: 'describe_text';
			parameters: [ScoringCriterion[], number, number?]; // rubric criteria, score threshold, min length
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
				parameters: ['Describe something that makes you happy.', 0.7]
			},
			{
				type: 'transcribe_audio',
				description: 'Describe your favorite food for 30 seconds.',
				parameters: ['Describe your favorite food.', 0.7]
			},
			{
				type: 'transcribe_audio',
				description: 'Describe your favorite place for 30 seconds.',
				parameters: ['Describe your favorite place.', 0.7],
				delay: 1200
			},
			[
				{
					type: 'transcribe_audio',
					description: 'Describe your favorite hobby for 30 seconds.',
					parameters: ['Describe your favorite hobby.', 0.7],
					reward: 50
				},
				{
					type: 'transcribe_audio',
					description: 'Describe your favorite animal for 30 seconds.',
					parameters: ['Describe your favorite animal.', 0.7],
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
				parameters: [41.8827, -87.6233, 50]
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
				parameters: [41.8917, -87.6091, 100],
				delay: 600
			},
			[
				{
					type: 'draw_picture',
					description: 'Draw the outline of the state of Illinois.',
					parameters: ['outline of Illinois', 0.7],
					reward: 25
				},
				{
					type: 'draw_picture',
					description: 'Draw the outline of Cook County.',
					parameters: ['outline of Cook County', 0.7],
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
	// rare quests
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
						['snowboard', 0.7],
						['skis', 0.7]
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
				parameters: ['Explain a scientific concept that you find interesting.', 0.7],
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
					parameters: ['robot', 0.8]
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
				parameters: ['Describe your favorite piece of technology.', 0.7],
				delay: 1800
			}
		],
		reward: 450,
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
					parameters: [44.428, -110.5885, 5000],
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
				parameters: ['Describe your favorite author.', 0.7],
				delay: 1800
			}
		],
		reward: 350,
		permissions: ['camera']
	}
] as Quest[];

export async function getAllQuests(kv: KVNamespace): Promise<(CustomQuest | Quest)[]> {
	const quests0 = [...quests];

	// add custom quests
	const customQuests = (await getCustomQuests(kv)).map(async (q) => await getCustomQuest(q.id, kv));

	return [...quests0, ...(await Promise.all(customQuests))].filter((q) => q != null);
}

export async function getQuest(id: string, kv: KVNamespace): Promise<CustomQuest | Quest | null> {
	const quest = quests.find((q) => q.id === id);
	if (quest) {
		return quest;
	}

	if (id.startsWith('activity_quest_')) {
		const activityId = id.replace('activity_quest_', '');
		const activity = await getActivity(activityId);
		if (!activity) return null;

		return designActivityQuest(activity);
	}

	return await getCustomQuest(id, kv);
}
