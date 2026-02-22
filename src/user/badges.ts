import type { KVNamespace } from '@cloudflare/workers-types';
import { normalizeId, isLegacyPaddedId, migrateLegacyKey } from '../util/util';
import { sendUserNotification } from './notifications';
import { Bindings } from '../util/types';
import { addImpactPoints } from './points';

export type BadgeTracker =
	| 'activities_added' // handled over mantle2
	| 'impact_points_earned'
	| 'prompts_responded' // handled over mantle2
	| 'events_created' // handled over mantle2
	| 'articles_read'
	| 'articles_read_time'
	| 'events_attended' // handled over mantle2
	| 'prompts_created' // handled over mantle2
	| 'event_images_submitted'
	| 'friends_added' // handled over mantle2
	| 'article_quizzes_completed'
	| 'event_types_attended' // handled over mantle2
	| 'event_countries_photographed'
	| 'article_quizzes_completed_perfect_score';

export type Badge = {
	id: string;
	name: string; // if not provided, normalized id is used
	description: string;
	icon: string;
	rarity: 'normal' | 'rare' | 'amazing' | 'green';
	// on request, badges are either granted automatically or based on this function; args are passed from the request
	progress?: (...args: any[]) => Promise<number> | number;
	tracker_id?: BadgeTracker; // if provided, links to a tracker in KV, an array of { date: number, value: string }
};

// use function instead of constant to avoid loading at import time
export const badges = (
	[
		// normal badges
		{
			id: 'getting_started',
			description: 'Add an activity to your profile',
			icon: 'mdi:rocket-launch',
			rarity: 'normal',
			progress: (...args: any[]) => min(args, 1),
			tracker_id: 'activities_added'
		},
		{
			id: 'activist',
			description: 'Retrieve your first impact points',
			icon: 'mdi:account-star',
			rarity: 'normal',
			progress: (...args: any[]) => min(args, 1),
			tracker_id: 'impact_points_earned'
		},
		{
			id: 'philosopher',
			description: 'Respond to a prompt',
			icon: 'mdi:brain',
			rarity: 'normal',
			progress: (...args: any[]) => min(args, 1),
			tracker_id: 'prompts_responded'
		},
		{
			id: 'event_planner',
			description: 'Create your first event',
			icon: 'mdi:calendar-star',
			rarity: 'normal',
			progress: (...args: any[]) => min(args, 1),
			tracker_id: 'events_created'
		},
		{
			id: 'verified',
			description: 'Verify your email address',
			icon: 'mdi:check-decagram',
			rarity: 'normal'
		},
		{
			id: 'article_enthusiast',
			description: 'Read 10 articles',
			icon: 'mdi:book-open-page-variant',
			rarity: 'normal',
			progress: (...args: any[]) => min(args, 10),
			tracker_id: 'articles_read'
		},
		{
			id: 'bookworm',
			description: 'Spend 1 hour reading an article',
			icon: 'mdi:book',
			rarity: 'normal',
			progress: (...args: any[]) => min(args, 60 * 60),
			tracker_id: 'articles_read_time'
		},
		{
			id: 'social_butterfly',
			description: 'Attend 5 events',
			icon: 'mdi:account-group',
			rarity: 'normal',
			progress: (...args: any[]) => min(args, 5),
			tracker_id: 'events_attended'
		},
		{
			id: 'thinker',
			description: 'Create 3 prompts',
			icon: 'material-symbols:person-outline',
			rarity: 'normal',
			progress: (...args: any[]) => min(args, 3),
			tracker_id: 'prompts_created'
		},
		{
			id: 'impacter',
			description: 'Achieve 100 impact points',
			icon: 'mdi:earth-arrow-right',
			rarity: 'normal',
			progress: (...args: any[]) => min(args, 100),
			tracker_id: 'impact_points_earned'
		},
		{
			id: 'going_outside',
			description: 'Submit your first image to an event',
			icon: 'mdi:camera-outline',
			rarity: 'normal',
			progress: (...args: any[]) => min(args, 1),
			tracker_id: 'event_images_submitted'
		},
		{
			id: 'collaborator',
			description: 'Add your first friend',
			icon: 'mdi:account-multiple-plus',
			rarity: 'normal',
			progress: (...args: any[]) => min(args, 1),
			tracker_id: 'friends_added'
		},
		{
			id: 'super_philosopher',
			description: 'Respond to 10 prompts',
			icon: 'mdi:thought-bubble-outline',
			rarity: 'normal',
			progress: (...args: any[]) => min(args, 10),
			tracker_id: 'prompts_responded'
		},
		{
			id: 'close_friends',
			description: 'Add someone to your close friends',
			icon: 'mdi:heart-circle',
			rarity: 'normal'
		},
		{
			id: 'student',
			description: 'Complete an article quiz',
			icon: 'mdi:school-outline',
			rarity: 'normal',
			progress: (...args: any[]) => min(args, 1),
			tracker_id: 'article_quizzes_completed'
		},
		// rare badges
		{
			id: 'avid_reader',
			description: 'Read 50 unique articles',
			icon: 'mdi:book-open-variant',
			rarity: 'rare',
			progress: (...args: any[]) => min(args, 50),
			tracker_id: 'articles_read'
		},
		{
			id: 'super_bookworm',
			description: 'Read articles for at least 5 hours',
			icon: 'mdi:book-arrow-up',
			rarity: 'rare',
			progress: (...args: any[]) => min(args, 60 * 60 * 5),
			tracker_id: 'articles_read_time'
		},
		{
			id: 'networker',
			description: 'Attend an online and in-person event',
			icon: 'mdi:handshake',
			rarity: 'rare',
			progress: (...args: any[]) => {
				const typesAttended = args[0] as string[];
				if (!Array.isArray(typesAttended)) return 0;

				const hasOnline = typesAttended.includes('ONLINE');
				const hasInPerson = typesAttended.includes('IN_PERSON');

				if (hasOnline && hasInPerson) return 1;
				if (hasOnline || hasInPerson) return 0.5;
				return 0;
			},
			tracker_id: 'event_types_attended'
		},
		{
			id: 'event_attendee',
			description: 'Attend 20 events',
			icon: 'mdi:account-multiple',
			rarity: 'rare',
			progress: (...args: any[]) => min(args, 20),
			tracker_id: 'events_attended'
		},
		{
			id: 'event_organizer',
			description: 'Organize 10 different events',
			icon: 'mdi:calendar-multiple',
			rarity: 'rare',
			progress: (...args: any[]) => min(args, 10),
			tracker_id: 'events_created'
		},
		{
			id: 'prompt_engineer',
			description: 'Create 20 prompts',
			icon: 'mdi:code-braces',
			rarity: 'rare',
			progress: (...args: any[]) => min(args, 20),
			tracker_id: 'prompts_created'
		},
		{
			id: 'rich_in_spirit',
			description: 'Add 10 activities to your profile',
			icon: 'mdi:star-four-points',
			rarity: 'rare',
			progress: (...args: any[]) => min(args, 10),
			tracker_id: 'activities_added'
		},
		{
			id: 'big_impact',
			description: 'Achieve 1,000 impact points',
			icon: 'mdi:earth',
			rarity: 'rare',
			progress: (...args: any[]) => min(args, 1000),
			tracker_id: 'impact_points_earned'
		},
		{
			id: 'storyteller',
			description: 'Create 5 articles',
			icon: 'mdi:book-edit',
			rarity: 'rare',
			progress: (...args: any[]) => min(args, 5),
			tracker_id: 'articles_created'
		},
		{
			id: 'adventurer',
			description: 'Submit images to 10 different events',
			icon: 'mdi:map',
			rarity: 'rare',
			progress: (...args: any[]) => min(args, 10),
			tracker_id: 'event_images_submitted'
		},
		{
			id: 'writer',
			description: 'Create 10 articles',
			icon: 'mdi:feather',
			rarity: 'rare',
			progress: (...args: any[]) => min(args, 10),
			tracker_id: 'articles_created'
		},
		{
			id: 'explorer',
			description: 'Submit images to 5 different events',
			icon: 'mdi:compass',
			rarity: 'rare',
			progress: (...args: any[]) => min(args, 5),
			tracker_id: 'event_images_submitted'
		},
		{
			id: 'invested',
			description: 'Read activity pages fro a combined total of 1 hour',
			icon: 'mdi:clock-outline',
			rarity: 'rare',
			progress: (...args: any[]) => min(args, 60),
			tracker_id: 'activity_pages_read_time'
		},
		{
			id: 'night_owl',
			description: 'Sign up for an event between 12 AM and 4 AM local time',
			icon: 'mdi:owl',
			rarity: 'rare'
		},
		{
			id: 'early_adopter',
			description: 'Have an account older than 6 months',
			icon: 'mdi:calendar-star',
			rarity: 'rare',
			progress: (...args: any[]) => {
				const createdAt = args[0] as Date;
				if (!(createdAt instanceof Date)) return 0;

				const daysSinceCreation = (Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24);
				return Math.min(daysSinceCreation / 182.5, 1);
			}
		},
		{
			id: 'dedicated_reader',
			description: 'Read 200 unique articles',
			icon: 'mdi:book-multiple',
			rarity: 'rare',
			progress: (...args: any[]) => min(args, 200),
			tracker_id: 'articles_read'
		},
		{
			id: 'article_nerd',
			description: 'Get 100% on an article quiz',
			icon: 'mdi:school',
			rarity: 'rare',
			progress: (...args: any[]) => min(args, 1),
			tracker_id: 'article_quizzes_completed_perfect_score'
		},
		{
			id: 'super_student',
			description: 'Complete 10 article quizzes',
			icon: 'mdi:account-school',
			rarity: 'rare',
			progress: (...args: any[]) => min(args, 10),
			tracker_id: 'article_quizzes_completed'
		},
		{
			id: 'world_photographer',
			description: 'Submit an image to events in 10 different countries',
			icon: 'mdi:camera-burst',
			rarity: 'rare',
			progress: (...args: any[]) => min(args, 10),
			tracker_id: 'event_countries_photographed'
		},
		{
			id: 'ultra_philosopher',
			description: 'Respond to 50 prompts',
			icon: 'mdi:thought-bubble',
			rarity: 'rare',
			progress: (...args: any[]) => min(args, 50),
			tracker_id: 'prompts_responded'
		},
		{
			id: 'outreacher',
			description: 'Become friends with someone outside of your country',
			icon: 'mdi:globe-model',
			rarity: 'rare'
		},
		// amazing badges
		{
			id: 'journey_master',
			description: 'Maintain a 30-day streak on any journey',
			icon: 'mdi:medal',
			rarity: 'amazing'
		},
		{
			id: 'old_account',
			name: '1 Year Ago',
			description: 'Have an account older than 1 year',
			icon: 'mdi:calendar-clock',
			rarity: 'amazing',
			progress: (...args: any[]) => {
				const createdAt = args[0] as Date;
				if (!(createdAt instanceof Date)) return 0;

				const daysSinceCreation = (Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24);
				return Math.min(daysSinceCreation / 365, 1);
			}
		},
		{
			id: 'dedicated_creator',
			description: 'Create 100 prompts',
			icon: 'mdi:pencil',
			rarity: 'amazing',
			progress: (...args: any[]) => min(args, 100),
			tracker_id: 'prompts_created'
		},
		{
			id: 'huge_impact',
			description: 'Achieve 10,000 impact points',
			icon: 'mdi:earth-plus',
			rarity: 'amazing',
			progress: (...args: any[]) => min(args, 10000),
			tracker_id: 'impact_points_earned'
		},
		{
			id: 'master_writer',
			description: 'Create 50 articles',
			icon: 'mdi:book-open-variant-outline',
			rarity: 'amazing',
			progress: (...args: any[]) => min(args, 50),
			tracker_id: 'articles_created'
		},
		{
			id: 'globetrotter',
			description: 'Submit images to events in 25 different countries',
			icon: 'mdi:camera-marker',
			rarity: 'amazing',
			progress: (...args: any[]) => min(args, 25),
			tracker_id: 'event_countries_photographed'
		},
		{
			id: 'world_explorer',
			description: 'Submit images to 30 different events',
			icon: 'mdi:earth-arrow-up',
			rarity: 'amazing',
			progress: (...args: any[]) => min(args, 30),
			tracker_id: 'event_images_submitted'
		},
		{
			id: 'early_bird',
			description: 'Sign up for an event between 4 AM and 9 AM local time',
			icon: 'mdi:bird',
			rarity: 'amazing'
		},
		{
			id: 'socialite',
			description: 'Attend 100 events',
			icon: 'mdi:party-popper',
			rarity: 'amazing',
			progress: (...args: any[]) => min(args, 100),
			tracker_id: 'events_attended'
		},
		{
			id: 'legendary_philosopher',
			description: 'Respond to 500 prompts',
			icon: 'material-symbols:mindfulness-outline',
			rarity: 'amazing',
			progress: (...args: any[]) => min(args, 500),
			tracker_id: 'prompts_responded'
		},
		{
			id: 'lifetime_reader',
			description: 'Read 600 unique articles',
			icon: 'mdi:comment-bookmark',
			rarity: 'amazing',
			progress: (...args: any[]) => min(args, 600),
			tracker_id: 'articles_read'
		},
		{
			id: 'juris_doctor',
			description: 'Get 100% on 10 article quizzes',
			icon: 'mdi:gavel',
			rarity: 'amazing',
			progress: (...args: any[]) => min(args, 10),
			tracker_id: 'article_quizzes_completed_perfect_score'
		},
		{
			id: 'super_bookworm',
			description: 'Read articles for at least 45 hours',
			icon: 'material-symbols:book-2',
			rarity: 'amazing',
			progress: (...args: any[]) => min(args, 60 * 60 * 45),
			tracker_id: 'articles_read_time'
		},
		// green badges
		{
			id: 'old_account_2',
			name: '3 Years Ago',
			description: 'Have an account older than 3 years',
			icon: 'mdi:calendar-clock',
			rarity: 'green',
			progress: (...args: any[]) => {
				const createdAt = args[0] as Date;
				if (!(createdAt instanceof Date)) return 0;

				const daysSinceCreation = (Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24);
				return Math.min(daysSinceCreation / 1095, 1);
			}
		},
		{
			id: 'ultimate_adventurer',
			description: 'Maintain a 365-day streak on any journey',
			icon: 'mdi:trophy-award',
			rarity: 'green'
		},
		{
			id: 'doctorate',
			description: 'Get 100% on 50 article quizzes',
			icon: 'mdi:script-text',
			rarity: 'green',
			progress: (...args: any[]) => min(args, 50),
			tracker_id: 'article_quizzes_completed_perfect_score'
		},
		{
			id: 'crazy_impact',
			description: 'Achieve 100,000 impact points',
			icon: 'mdi:shovel',
			rarity: 'green',
			progress: (...args: any[]) => min(args, 100000),
			tracker_id: 'impact_points_earned'
		},
		{
			id: 'you_know_ball',
			description: 'Become friends with an administrator',
			icon: 'mdi:shield-star',
			rarity: 'green'
		},
		{
			id: 'eternal_reader',
			description: 'Read 1,000 unique articles',
			icon: 'mdi:bookshelf',
			rarity: 'green',
			progress: (...args: any[]) => min(args, 1000),
			tracker_id: 'articles_read'
		},
		{
			id: 'legendary_writer',
			description: 'Create 1,000 articles',
			icon: 'material-symbols:stylus-pencil',
			rarity: 'green',
			progress: (...args: any[]) => min(args, 1000),
			tracker_id: 'articles_created'
		},
		{
			id: 'world_changer',
			description: 'Achieve 1,000,000 impact points',
			icon: 'mdi:star-plus',
			rarity: 'green',
			progress: (...args: any[]) => min(args, 1000000),
			tracker_id: 'impact_points_earned'
		},
		{
			id: 'einstein',
			description: 'Respond to 3,000 prompts',
			icon: 'material-symbols:science-outline',
			rarity: 'green',
			progress: (...args: any[]) => min(args, 3000),
			tracker_id: 'prompts_responded'
		},
		{
			id: 'immortal_bookworm',
			description: 'Read articles for at least 350 hours',
			icon: 'material-symbols:book-5',
			rarity: 'green',
			progress: (...args: any[]) => min(args, 60 * 60 * 350),
			tracker_id: 'articles_read_time'
		}
	] as (Badge & { name?: string })[]
).map((badge) => {
	if (!badge.name) {
		// normalize id to name
		badge.name = badge.id
			.split('_')
			.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
			.join(' ');
	}

	return badge;
});

// progress helper functions (returns value between 0 and 1

function min(args: any[], min: number): number {
	if (Array.isArray(args[0])) {
		const value = args[0].length;
		return Math.min(value, min) / min;
	}

	if (typeof args[0] === 'number') {
		const value = args[0];
		return Math.min(value, min) / min;
	}

	const value = parseInt(args[0]);
	return isNaN(value) ? 0 : Math.min(value, min) / min;
}

// storage functions

type TrackerEntry = {
	date: number;
	value: string | number;
};

type BadgeMetadata = {
	granted_at: number;
};

// Migration helper to flatten legacy compounding array data
function migrateLegacyTrackerData(tracker: any[]): TrackerEntry[] {
	if (!tracker || tracker.length === 0) return [];

	const uniqueStringValues = new Set<string>();
	const migratedEntries: TrackerEntry[] = [];
	let lastNumericValue: number | null = null;
	let lastNumericDate: number | null = null;

	for (const entry of tracker) {
		if (!entry || typeof entry !== 'object') continue;

		const { date, value } = entry;

		// Handle array values (legacy bad data)
		if (Array.isArray(value)) {
			for (const v of value) {
				if (typeof v === 'number') {
					// For numbers, keep track of the highest value (most recent accumulated total)
					if (lastNumericValue === null || v > lastNumericValue) {
						lastNumericValue = v;
						lastNumericDate = date;
					}
				} else if (typeof v === 'string' && !uniqueStringValues.has(v)) {
					uniqueStringValues.add(v);
					migratedEntries.push({ date, value: v });
				}
			}
		} else if (typeof value === 'number') {
			// For numbers, keep track of the highest value (most recent accumulated total)
			if (lastNumericValue === null || value > lastNumericValue) {
				lastNumericValue = value;
				lastNumericDate = date;
			}
		} else if (typeof value === 'string' && !uniqueStringValues.has(value)) {
			uniqueStringValues.add(value);
			migratedEntries.push({ date, value });
		}
	}

	// Add the single numeric entry if we found any numbers
	if (lastNumericValue !== null && lastNumericDate !== null) {
		migratedEntries.push({ date: lastNumericDate, value: lastNumericValue });
	}

	return migratedEntries;
}

export async function getBadgeProgress(
	userId: string,
	badgeId: string,
	kv: KVNamespace,
	...progressArgs: any[]
): Promise<number> {
	const normalizedUserId = normalizeId(userId);
	const badge = badges.find((b) => b.id === badgeId);
	if (!badge) return 0;

	if (!badge.progress) {
		const isGranted = await isBadgeGranted(normalizedUserId, badgeId, kv);
		return isGranted ? 1 : 0;
	}

	if (badge.tracker_id) {
		const trackerKey = `user:badge_tracker:${normalizedUserId}:${badge.tracker_id}`;
		let trackerData = await kv.get(trackerKey, 'json');

		// Fallback: check for legacy zero-padded key
		if (!trackerData && isLegacyPaddedId(userId)) {
			const legacyKey = `user:badge_tracker:${userId}:${badge.tracker_id}`;
			const legacyData = await kv.get(legacyKey, 'json');
			if (legacyData) {
				// Migrate in background
				await migrateLegacyKey(legacyKey, trackerKey, kv);
				trackerData = legacyData;
			}
		}

		let tracker: TrackerEntry[] = trackerData ? (trackerData as TrackerEntry[]) : [];

		// Migrate legacy data if needed
		tracker = migrateLegacyTrackerData(tracker);

		// Determine if this tracker stores numbers or strings
		const lastEntry = tracker.length > 0 ? tracker[tracker.length - 1] : null;

		if (lastEntry && typeof lastEntry.value === 'number') {
			// For numeric trackers, pass the latest accumulated value
			return await badge.progress(lastEntry.value, ...progressArgs);
		} else {
			// For string trackers, pass array of unique values (for counting)
			const uniqueValues = Array.from(new Set(tracker.map((t) => t.value)));
			return await badge.progress(uniqueValues, ...progressArgs);
		}
	}

	return await badge.progress(...progressArgs);
}

export async function addBadgeProgress(
	userId: string,
	trackerId: string,
	value: TrackerEntry['value'] | TrackerEntry['value'][],
	kv: KVNamespace
): Promise<void> {
	const normalizedUserId = normalizeId(userId);
	const trackerKey = `user:badge_tracker:${normalizedUserId}:${trackerId}`;
	const trackerData = await kv.get(trackerKey, 'json');
	let tracker: TrackerEntry[] = trackerData ? (trackerData as TrackerEntry[]) : [];

	// Migrate legacy data if needed (flatten arrays)
	tracker = migrateLegacyTrackerData(tracker);
	const values = Array.isArray(value) ? value : [value];

	const numbers = values.filter((v): v is number => typeof v === 'number');
	const strings = values.filter((v): v is string => typeof v === 'string');

	// Detect existing tracker type to prevent mixing types
	const existingType = tracker.length > 0 && tracker[0] ? typeof tracker[0].value : null;

	if (numbers.length > 0) {
		// Validate: don't mix types in a tracker
		if (existingType === 'string') {
			console.warn(`Attempted to add numbers to string tracker: ${trackerId}`);
			return;
		}

		const sumToAdd = numbers.reduce((acc, val) => acc + val, 0);
		const lastEntry = tracker.length > 0 ? tracker[tracker.length - 1] : null;

		if (lastEntry && typeof lastEntry.value === 'number') {
			lastEntry.value = lastEntry.value + sumToAdd;
			lastEntry.date = Date.now();
		} else {
			// First numeric entry for this tracker
			tracker.push({
				date: Date.now(),
				value: sumToAdd
			});
		}
	}

	// Handle strings: add each unique value as separate entry
	if (strings.length > 0) {
		// Validate: don't mix types in a tracker
		if (existingType === 'number') {
			console.warn(`Attempted to add strings to number tracker: ${trackerId}`);
			return;
		}

		const existingValues = new Set(tracker.map((t) => t.value));

		for (const val of strings) {
			// Normalize IDs if this looks like an ID (numeric string)
			const normalizedValue = normalizeId(val);

			// Only add if not already present (prevent duplicates)
			if (!existingValues.has(normalizedValue)) {
				tracker.push({
					date: Date.now(),
					value: normalizedValue
				});
				existingValues.add(normalizedValue); // Update set to prevent duplicates within this batch
			}
		}
	}

	await kv.put(trackerKey, JSON.stringify(tracker));
}

export async function grantBadge(userId: string, badgeId: string, kv: KVNamespace): Promise<void> {
	const normalizedUserId = normalizeId(userId);
	const badge = badges.find((b) => b.id === badgeId);
	if (!badge) return;

	const metadataKey = `user:badge:${normalizedUserId}:${badgeId}`;
	const metadata: BadgeMetadata = {
		granted_at: Date.now()
	};

	await kv.put(metadataKey, JSON.stringify(metadata));

	// add impact points for granting this badge
	// wrap in try/catch to prevent any issues with impact points from blocking badge grants
	try {
		if (badge.tracker_id === 'impact_points_earned') {
			// if this badge is directly related to impact points, don't add points to prevent loops
			return;
		}

		// add impact points based on badge rarity
		let pointsToAdd = 0;
		switch (badge.rarity) {
			case 'normal':
				pointsToAdd = 10;
				break;
			case 'rare':
				pointsToAdd = 25;
				break;
			case 'amazing':
				pointsToAdd = 60;
				break;
			case 'green':
				pointsToAdd = 150;
				break;
		}

		await addImpactPoints(normalizedUserId, pointsToAdd, `Badge Unlocked: ${badge.name}`, kv);
		await addBadgeProgress(normalizedUserId, 'impact_points_earned', pointsToAdd, kv);
	} catch (error) {
		console.error('Error adding impact points for badge grant:', error);
	}
}

export async function isBadgeGranted(
	userId: string,
	badgeId: string,
	kv: KVNamespace
): Promise<boolean> {
	const normalizedUserId = normalizeId(userId);
	const metadataKey = `user:badge:${normalizedUserId}:${badgeId}`;
	const metadata = await kv.get(metadataKey);
	return metadata !== null;
}

export async function getBadgeMetadata(
	userId: string,
	badgeId: string,
	kv: KVNamespace
): Promise<BadgeMetadata | null> {
	const normalizedUserId = normalizeId(userId);
	const metadataKey = `user:badge:${normalizedUserId}:${badgeId}`;
	let metadata = await kv.get(metadataKey, 'json');

	// Fallback: check for legacy zero-padded key
	if (!metadata && isLegacyPaddedId(userId)) {
		const legacyKey = `user:badge:${userId}:${badgeId}`;
		const legacyMetadata = await kv.get(legacyKey, 'json');
		if (legacyMetadata) {
			// Migrate in background
			await migrateLegacyKey(legacyKey, metadataKey, kv);
			metadata = legacyMetadata;
		}
	}

	return metadata ? (metadata as BadgeMetadata) : null;
}

export async function getGrantedBadges(userId: string, kv: KVNamespace): Promise<string[]> {
	const normalizedUserId = normalizeId(userId);
	const prefix = `user:badge:${normalizedUserId}:`;
	const list = await kv.list({ prefix });
	const badgeIds = list.keys.map((key) => key.name.replace(prefix, ''));

	// Also check for legacy zero-padded keys
	if (isLegacyPaddedId(userId)) {
		const legacyPrefix = `user:badge:${userId}:`;
		const legacyList = await kv.list({ prefix: legacyPrefix });

		for (const key of legacyList.keys) {
			const badgeId = key.name.replace(legacyPrefix, '');
			if (!badgeIds.includes(badgeId)) {
				badgeIds.push(badgeId);
				// Migrate in background
				const newKey = `user:badge:${normalizedUserId}:${badgeId}`;
				await migrateLegacyKey(key.name, newKey, kv);
			}
		}
	}

	return badgeIds;
}

export async function getNonGrantedBadges(userId: string, kv: KVNamespace): Promise<string[]> {
	const normalizedUserId = normalizeId(userId);
	const grantedBadges = await getGrantedBadges(normalizedUserId, kv);
	const grantedSet = new Set(grantedBadges);

	return badges.filter((b) => !grantedSet.has(b.id)).map((b) => b.id);
}

export async function revokeBadge(userId: string, badgeId: string, kv: KVNamespace): Promise<void> {
	const normalizedUserId = normalizeId(userId);
	const metadataKey = `user:badge:${normalizedUserId}:${badgeId}`;
	await kv.delete(metadataKey);
}

export async function resetBadgeProgress(
	userId: string,
	badgeId: string,
	kv: KVNamespace
): Promise<void> {
	const normalizedUserId = normalizeId(userId);
	const badge = badges.find((b) => b.id === badgeId);
	if (!badge || !badge.tracker_id) return;

	const trackerKey = `user:badge_tracker:${normalizedUserId}:${badge.tracker_id}`;
	await kv.delete(trackerKey);

	// revoke the badge if granted
	await revokeBadge(normalizedUserId, badgeId, kv);
}

export async function checkAndGrantBadges(
	userId: string,
	trackerId: string,
	bindings: Bindings,
	ctx: ExecutionContext
): Promise<string[]> {
	const kv = bindings.KV;
	const normalizedUserId = normalizeId(userId);
	// Find all badges that use this tracker
	const relevantBadges = badges.filter((b) => b.tracker_id === trackerId);
	const newlyGranted: string[] = [];

	for (const badge of relevantBadges) {
		if (await isBadgeGranted(normalizedUserId, badge.id, kv)) {
			continue;
		}

		const progress = await getBadgeProgress(normalizedUserId, badge.id, kv);
		if (progress >= 1) {
			await grantBadge(normalizedUserId, badge.id, kv);
			newlyGranted.push(badge.id);
		}
	}

	// send notification
	ctx.waitUntil(
		sendUserNotification(
			bindings,
			normalizedUserId,
			newlyGranted.length > 1 ? 'New Badges Unlocked!' : 'New Badge Unlocked!',
			newlyGranted.length > 1
				? `You've unlocked the following badges: ${newlyGranted
						.map((id) => {
							const badge = badges.find((b) => b.id === id);
							return badge ? badge.name : id;
						})
						.join(', ')}.`
				: `You've unlocked the "${badges.find((b) => b.id === newlyGranted[0])?.name}" badge!`,
			undefined,
			'success'
		)
	);

	return newlyGranted;
}
