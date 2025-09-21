import { Ai, KVNamespace, R2Bucket } from '@cloudflare/workers-types';
import { com } from '@earth-app/ocean';

export type Bindings = {
	R2: R2Bucket;
	AI: Ai;
	ASSETS: Fetcher;

	ADMIN_API_KEY: string;
	NCBI_API_KEY: string;
	MANTLE_URL: string;
};

export type Activity = {
	id: string;
	name: string;
	description: string;
	aliases: string[];
	types: string[];
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
	visibility: typeof com.earthapp.account.Privacy.prototype.name;
	created_at: Date;
	updated_at?: Date;
};
