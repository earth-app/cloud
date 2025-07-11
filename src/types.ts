import { Ai, D1Database, Fetcher } from '@cloudflare/workers-types';

export type Bindings = {
	DB: D1Database;
	R2: R2Bucket;
	AI: Ai;
	ASSETS: Fetcher;

	ADMIN_API_TOKEN: string;
	NCBI_API_KEY: string;
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
