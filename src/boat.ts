import { com } from '@earth-app/ocean';
import { Context } from 'hono';
import { deflate } from 'pako';
import { Bindings } from './types';

export type Article = {
	title: string;
	author: string;
	source: string;
	url: string;
	abstract: string;
	content: string;
	theme_color: string;
	keywords: string[];
	date: string;
	favicon: string;
	links: {
		[key: string]: string;
	};
};

let HAS_PUBMED_API_KEY = false;
export async function findArticles(
	query: string,
	c: Context<{ Bindings: Bindings }>,
	limit: number = 1
) {
	if (!HAS_PUBMED_API_KEY && c.env.NCBI_API_KEY) {
		com.earthapp.ocean.boat.Scraper.setApiKey('PubMed', c.env.NCBI_API_KEY);
		HAS_PUBMED_API_KEY = true;
	}

	const res = await com.earthapp.ocean.boat.searchAllAsPromise(
		com.earthapp.ocean.boat.Scraper.Companion,
		query,
		limit
	);
	const results = res
		.asJsReadonlyArrayView()
		.map(async (item) => JSON.parse(item.toJson()) as Article);

	return await Promise.all(results);
}

export async function createArticles(
	query: string,
	c: Context<{ Bindings: Bindings }>,
	limit: number = 3
) {
	const articles = await findArticles(query, c, limit);
	const compressed = deflate(JSON.stringify(articles));

	const baseName = query.replace(/\s+/g, '_');
	const fileName = `cloud/boat/${encodeURIComponent(baseName)}.json.gz`;

	const exists = await c.env.R2.head(fileName);
	if (exists) {
		console.log(`File ${fileName} already exists in R2, deleting before upload.`);
		await c.env.R2.delete(fileName);
	}
	await c.env.R2.put(fileName, compressed, {
		httpMetadata: { contentType: 'application/gzip' }
	});
}
