import { Ai, D1Database, Fetcher } from '@cloudflare/workers-types';

export type Bindings = {
	DB: D1Database;
	AI: Ai;
	ASSETS: Fetcher;

	ADMIN_API_TOKEN: string;
};

export type ActivityData = {
	id: number;
	name: string;
	human_name: string;
	description: string;
	aliases?: string;
	types: string;
	created_at: string;
	updated_at?: string;
};
