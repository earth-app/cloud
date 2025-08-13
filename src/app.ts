import * as ocean from '@earth-app/ocean';
import { Hono } from 'hono';

import { createArticle, findArticles } from './boat';
import { getSynonyms } from './lang';
import * as prompts from './prompts';

import { Activity as Activity, Bindings } from './types';
import { bearerAuth } from 'hono/bearer-auth';
import { trimToByteLimit } from './util';

const textModel = '@cf/qwen/qwen1.5-14b-chat-awq';
const app = new Hono<{ Bindings: Bindings }>();

app.use('*', async (c, next) => {
	const token = c.env.ADMIN_API_KEY;
	return bearerAuth({ token })(c, next);
});

// Implementation
app.get('/synonyms', async (c) => {
	const word = c.req.query('word')?.trim();
	if (!word || word.length < 3) {
		return c.text('Word must be at least 3 characters long', 400);
	}

	const synonyms = await getSynonyms(word);
	if (!synonyms || synonyms.length === 0) {
		return c.json([], 200);
	}

	return c.json(synonyms, 200);
});

app.get('/activity/:id', async (c) => {
	const id = c.req.param('id')?.toLowerCase();
	if (!id) {
		return c.text('Activity ID is required', 400);
	}

	if (id.length < 3 || id.length > 20) {
		return c.text('Activity ID must be between 3 and 20 characters', 400);
	}

	const activity = id.replace(/_/g, ' ');

	// Generate description
	const description = await c.env.AI.run(textModel, {
		messages: [
			{ role: 'system', content: prompts.activityDescriptionSystemMessage.trim() },
			{ role: 'user', content: prompts.activityDescriptionPrompt(activity).trim() }
		],
		max_tokens: 350
	});
	const descRaw = description?.response?.trim() || `No description available for ${id}.`;

	// Generate tags
	const tagsResult = await c.env.AI.run(textModel, {
		messages: [
			{ role: 'system', content: prompts.activityTagsSystemMessage.trim() },
			{ role: 'user', content: activity }
		],
		max_tokens: 60
	});
	const validTags = ocean.com.earthapp.activity.ActivityType.values().map((t) =>
		t.name.trim().toUpperCase()
	);
	const tags = tagsResult?.response
		?.trim()
		.split(',')
		.map((tag) =>
			tag
				.trim()
				.toUpperCase()
				.replace(/[^A-Z0-9_]/g, '')
		)
		.filter((tag) => tag.length > 0)
		.filter((tag) => validTags.includes(tag)) || ['OTHER'];

	let aliases: string[] = [];
	const synonyms = await getSynonyms(activity);
	if (synonyms && synonyms.length > 0) {
		aliases.push(
			...synonyms
				.map((syn) => syn.trim().toLowerCase())
				.filter((syn) => syn.length > 0 && syn !== activity)
		);
	}

	const activityData = {
		id: id,
		name: id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
		types: tags,
		description: descRaw,
		aliases: aliases
	} satisfies Activity;

	return c.json(activityData, 201);
});

app.get('/articles/search', async (c) => {
	const query = c.req.query('q')?.trim();
	if (!query || query.length < 3) {
		return c.text('Query must be at least 3 characters long', 400);
	}

	try {
		const articles = await findArticles(query, c);
		if (articles.length === 0) {
			return c.text('No articles found', 404);
		}

		return c.json(articles, 200);
	} catch (err) {
		console.error(`Error searching articles for query '${query}':`, err);
		return c.text('Failed to search articles', 500);
	}
});

app.get('/articles/create', async (c) => {
	const query = c.req.query('q')?.trim();
	if (!query || query.length < 3) {
		return c.text('Query must be at least 3 characters long', 400);
	}

	try {
		const articles = await findArticles(query, c, 5);
		if (articles.length === 0) {
			return c.text('No articles found', 404);
		}

		let article = articles[Math.floor(Math.random() * articles.length)];
		let kvId = `article:cloud:${article.url}`;
		let attempts = 0;
		const maxAttempts = articles.length * 2;

		// Find article that is not already in KV
		while (attempts < maxAttempts) {
			const existingArticle = await c.env.KV.get(kvId);
			if (!existingArticle) break; // Article not found in KV, we can use it

			article = articles[Math.floor(Math.random() * articles.length)];
			kvId = `article:cloud:${article.url}`;
			attempts++;
		}

		// If all articles are already in KV, return the last one anyway or error
		if (attempts >= maxAttempts) {
			return c.text('All available articles for this query already exist', 409);
		}

		const articleData = await createArticle(article, c.env.AI);

		// Max 1024 bytes; 2 bytes per character
		const metadata = {
			title: trimToByteLimit(articleData.title, 200), // Max 200 bytes
			author: trimToByteLimit(articleData.author, 100), // Max 100 bytes
			tags: articleData.tags.slice(0, 5).map((tag) => trimToByteLimit(tag, 30)), // Max 150 bytes (30 x 5)
			summary: trimToByteLimit(articleData.content, 512), // Max 512 bytes,
			created_at: Date.now() // Max 8 bytes (32-bit integer)
		};
		// Total Max: 200 + 100 + 150 + 512 + 8 = 970 bytes

		// Assert Metadata is below 1024 bytes
		const byteSize = (obj: Record<string, any>) => {
			return new TextEncoder().encode(JSON.stringify(obj)).length;
		};
		if (byteSize(metadata) > 1024) {
			return c.text(
				`Cloud Metadata for "${articleData.title}" at ${articleData.ocean.url} exceeds maximum size of 1024 bytes`,
				500
			);
		}

		await c.env.KV.put(kvId, JSON.stringify(articleData), { metadata });

		return c.json(articleData, 201);
	} catch (err) {
		console.error(`Error searching articles for query '${query}':`, err);
		return c.text('Failed to search articles', 500);
	}
});

export default app;
