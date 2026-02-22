import { Ai, KVNamespace, R2Bucket, Fetcher } from '@cloudflare/workers-types';
import { com } from '@earth-app/ocean';
import { ScoreResult } from '../content/ferry';

export type Bindings = {
	R2: R2Bucket;
	AI: Ai;
	KV: KVNamespace;
	CACHE: KVNamespace;
	ASSETS: Fetcher;
	IMAGES: ImagesBinding;
	NOTIFIER: DurableObjectNamespace;
	TIMER: DurableObjectNamespace;

	ADMIN_API_KEY: string;
	NCBI_API_KEY: string;
	MANTLE_URL: string;
	MAPS_API_KEY: string;
	ENCRYPTION_KEY: string;
};

export type ActivityType = typeof com.earthapp.activity.ActivityType.prototype.name;
export type Privacy = typeof com.earthapp.account.Privacy.prototype.name;

export type Activity = {
	id: string;
	name: string;
	description: string;
	aliases: string[];
	types: ActivityType[];
	fields: {
		[key: string]: string;
	};
};

export type OceanArticle = {
	title: string;
	author: string;
	source: string;
	url: string;
	abstract?: string;
	content?: string;
	theme_color?: string;
	keywords: string[];
	date: string;
	favicon?: string;
	links: {
		[key: string]: string;
	};
};

export type Article = {
	id: string;
	title: string;
	description: string;
	tags: string[];
	content: string;
	author: {}; // user object
	author_id: string;
	color: string;
	color_hex: string;
	created_at: string;
	updated_at?: string;
	ocean: OceanArticle;
};

export type Prompt = {
	id: string;
	owner_id: string;
	prompt: string;
	visibility: Privacy;
	created_at: Date;
	updated_at?: Date;
};

export type EventActivity =
	| {
			type: 'activity_type';
			value: ActivityType;
	  }
	| ({
			type: 'activity';
	  } & Activity);

export type Event = {
	id: string;
	name: string;
	description: string;
	type: 'ONLINE' | 'IN_PERSON' | 'HYBRID';
	date: number;
	end_date?: number;
	visibility: Privacy;
	activities: EventActivity[];
	location?: {
		latitude: number;
		longitude: number;
	};
	fields: {
		[key: string]: string;
	};
};

export function eventActivitiesList(event: Event): string[] {
	const activities: string[] = [];
	for (const activity of event.activities) {
		if (activity.type === 'activity_type') {
			activities.push(activity.value.replace(/_/g, ' '));
		} else {
			activities.push(activity.name);
		}
	}

	return activities;
}

export type EventData = Omit<Event, 'id' | 'activities'> & {
	activities: (string | ActivityType)[];
};

export type EventImageSubmission = {
	id: string;
	image: Uint8Array;
};

export type EventImage = Omit<EventImageSubmission, 'image'> & {
	image: string;
	score?: ScoreResult;
	caption?: string;
	scored_at?: Date;
	user_id?: string;
};
