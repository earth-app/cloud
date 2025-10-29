# cloud

> The Automaton behind The Earth App

A sophisticated Cloudflare Workers-based microservice that powers The Earth App's
AI-driven content generation, recommendation engine, and user journey tracking.
Built with Hono.js, this service orchestrates multiple AI models, manages
distributed caching, and provides a comprehensive REST API for activity
discovery, article curation, and personalized recommendations.

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Technology Stack](#technology-stack)
- [Infrastructure & Bindings](#infrastructure--bindings)
- [Core Features](#core-features)
- [API Reference](#api-reference)
- [AI Models & Prompting](#ai-models--prompting)
- [Caching Strategy](#caching-strategy)
- [Scheduled Tasks](#scheduled-tasks)
- [Development](#development)
- [Deployment](#deployment)

## Architecture Overview

The Cloud service is a serverless application running on Cloudflare Workers that
implements a multi-layered architecture:

```
┌─────────────────────────────────────────────────────────────┐
│                      Hono.js Router                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │  Middleware  │  │   API v1     │  │   Scheduled  │      │
│  │  - Security  │  │  - Activities│  │   - Hourly   │      │
│  │  - CORS      │  │  - Articles  │  │   - 4-hourly │      │
│  │  - Cache     │  │  - Users     │  │              │      │
│  │  - Logger    │  │  - Journeys  │  │              │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
└─────────────────────────────────────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
   ┌─────────┐        ┌─────────┐        ┌─────────┐
   │   AI    │        │   KV    │        │   R2    │
   │ Models  │        │  Cache  │        │ Storage │
   └─────────┘        └─────────┘        └─────────┘
        │                                      │
        ▼                                      ▼
  ┌──────────────────────────────────────────────┐
  │     External Services & Data Sources         │
  │  - NCBI PubMed API (Scientific Articles)    │
  │  - Iconify API (Activity Icons)             │
  │  - Dictionary API (Synonyms)                │
  │  - Mantle API (Backend Integration)         │
  └──────────────────────────────────────────────┘
```

### Request Flow

1. **Incoming Request** → Middleware stack (security headers, CORS, logging)
2. **Authentication** → Bearer token validation against `ADMIN_API_KEY`
3. **Cache Check** → KV lookup with TTL-based invalidation (12-hour default)
4. **Business Logic** → AI model invocation, data processing, validation
5. **Response** → JSON serialization with custom headers (`X-Earth-App-Version`, `X-Earth-App-Name`)

## Technology Stack

### Core Dependencies

| Package                       | Version       | Purpose                                                             |
| ----------------------------- | ------------- | ------------------------------------------------------------------- |
| **Hono**                      | ^4.10.3       | Ultra-fast web framework optimized for edge computing               |
| **@cloudflare/workers-types** | ^4.20251014.0 | TypeScript definitions for Cloudflare Workers APIs                  |
| **@earth-app/ocean**          | 1.0.0-a752a2e | Kotlin-compiled WASM library for article scraping & recommendations |
| **pako**                      | ^2.1.0        | zlib compression (enabled via `nodejs_zlib` compatibility flag)     |

### Development Tools

- **Wrangler** (^4.45.2): Cloudflare Workers CLI for local development and deployment
- **Prettier** (^3.6.2): Code formatting with Husky pre-commit hooks
- **Bun**: JavaScript runtime for package management and local testing

## Infrastructure & Bindings

The service integrates with multiple Cloudflare services via environment bindings:

### Storage Bindings

```typescript
type Bindings = {
	R2: R2Bucket; // Object storage for user profile images
	KV: KVNamespace; // General key-value persistence
	CACHE: KVNamespace; // Dedicated caching layer (12-hour TTL)
	ASSETS: Fetcher; // Static asset serving (public/ directory)

	AI: Ai; // Cloudflare Workers AI gateway

	ADMIN_API_KEY: string; // Bearer token for API authentication
	NCBI_API_KEY: string; // NCBI E-utilities API key for PubMed access
	MANTLE_URL: string; // Backend API base URL (default: https://api.earth-app.com)
};
```

### Cloudflare KV Namespaces

- **CACHE** (`c4a1aaf2a5fc4be98b91df2d0fc0faab`): Ephemeral data with 12-hour TTL
  - Activity descriptions, tags, icons
  - Article rankings and recommendations
  - User profile photos (data URLs)

- **KV** (`322faefd5628471cb7cea08cf041804a`): Persistent data
  - User journey streaks (2-day expiration with auto-renewal)
  - Activity completion logs (no expiration)

### R2 Bucket

- **Bucket**: `earth-app` (production) / `earth-app-preview` (development)
- **Contents**: User-generated profile images (`users/{id}/profile.png`)
- **Metadata**: HTTP headers (`contentType: image/png`)

### Cloudflare Workers AI

Configured for **remote execution** to bypass CPU limits. Supports:

- Text generation (LLMs)
- Text-to-image generation (Stable Diffusion)
- Reranking models (semantic search)

## Core Features

### 1. Dynamic Activity Generation

Generates comprehensive activity metadata using multi-stage AI processing:

```typescript
// GET /v1/activity/:id
{
  id: "rock_climbing",
  name: "Rock Climbing",
  description: "Rock climbing is an exhilarating...", // 200-500 words
  aliases: ["climbing", "bouldering", "mountaineering"],
  types: ["SPORT", "HEALTH", "NATURE"],
  fields: {
    icon: "mdi:climbing"  // From Iconify API
  }
}
```

**AI Pipeline:**

1. **Description Generation** (`@cf/meta/llama-4-scout-17b-16e-instruct`)
   - Retry logic: 3 attempts with validation
   - Length: 200-500 words
   - Validation: Checks for markdown artifacts, proper punctuation

2. **Tag Classification** (`@cf/meta/llama-3.1-8b-instruct-fp8`)
   - Maps to predefined `ActivityType` enum
   - Max 5 tags, fallback to `["OTHER"]`

3. **Alias Discovery** (Dictionary API)
   - Fetches synonyms from dictionaryapi.dev
   - Filters multi-word phrases, limits to 5

4. **Icon Matching** (Iconify API)
   - Preferred sets: `mdi`, `material-symbols`, `lucide`, `carbon`
   - Prioritizes "rounded" variants

### 2. Scientific Article Curation

Automated article discovery, ranking, and summarization:

**Scheduled Task** (every 4 hours):

```typescript
// Workflow:
1. Generate topic (1-3 words) using @cf/meta/llama-3.2-3b-instruct
2. Search PubMed + open-access journals via @earth-app/ocean
3. Rank articles using @cf/baai/bge-reranker-base (semantic similarity)
4. Generate title + summary using @cf/mistralai/mistral-small-3.1-24b-instruct
5. POST to /v2/articles (Mantle backend)
```

**Ranking Algorithm:**

- Batched processing: 125 articles per chunk (GPU memory optimization)
- Query: `"Articles primarily related to {topic} and tags: {tags}"`
- Output: Cosine similarity scores, sorted descending

**Content Validation:**

- Title: 5-20 words, no markdown, no alternative titles (e.g., "Title A OR Title B")
- Summary: 400-900 words, multi-paragraph format with natural transitions
- Sanitization: Removes AI artifacts ("Here's...", "The answer is...")

### 3. Recommendation Engine

Multi-modal recommendation system using semantic reranking:

#### Article Recommendations (`POST /v1/users/recommend_articles`)

```json
{
	"pool": [
		/* max 20 articles */
	],
	"activities": ["hiking", "photography"], // max 10
	"limit": 10 // max 25
}
```

**Algorithm:**

- Query construction: `"Recommend articles related to {activities}"`
- Model: `@cf/baai/bge-reranker-base` (BGE-Reranker-Base)
- Context window: 512 tokens (title + tags + description excerpt)

#### Similar Articles (`POST /v1/articles/recommend_similar_articles`)

```json
{
	"article": {
		/* reference article */
	},
	"pool": [
		/* candidates, max 20 */
	],
	"limit": 5 // max 10
}
```

**Similarity Scoring:**

- Query: Reference article's title + tags + content (first 500 chars)
- Returns: Top-N articles by cosine similarity to reference

#### Activity Recommendations (`POST /v1/users/recommend_activities`)

- Uses `@earth-app/ocean` Kotlin library (compiled to WASM)
- Algorithm: Collaborative filtering based on activity co-occurrence
- Input: All available activities + user's current activities
- Output: Deduplicated recommendations (seen IDs filtered)

### 4. User Journey Tracking

Persistent streak tracking with automatic expiration:

```typescript
// Journey types: 'article', 'prompt'
// Storage: KV with 2-day TTL (auto-renewed on increment)

GET  /v1/users/journey/:type/:id        → { count, lastWrite }
POST /v1/users/journey/:type/:id/increment → { count }
DELETE /v1/users/journey/:type/:id/delete  → 204 No Content
```

**Activity Journey** (special type):

```typescript
GET  /v1/users/journey/activity/:id/count  → { count }
POST /v1/users/journey/activity/:id?activity=hiking → { count }
```

- Storage: JSON array of activity IDs
- No expiration (permanent completion log)

### 5. AI-Generated Prompts

Daily thought-provoking questions using advanced reasoning:

**Model:** `@cf/openai/gpt-oss-120b` (GPT-4-class model)

```typescript
{
  instructions: "Generate exactly ONE original, thought-provoking question...",
  input: "Create a question with prefix 'Why' about 'psychology'",
  reasoning: {
    effort: 'medium',
    summary: 'concise'
  }
}
```

**Validation Rules:**

- Length: <15 words, <100 characters
- Format: Ends with `?`
- Prohibited words: "what if", "imagine", "you", "your", "I", "my"
- Tone: Timeless, open-ended (not yes/no)

**Examples:**

- "Why do some habits stick while others fade?"
- "How does curiosity shape learning?"

### 6. Dynamic Profile Photo Generation

Personalized AI-generated profile pictures:

```typescript
PUT /v1/users/profile_photo/:id
Body: {
  username, bio, created_at, country, full_name,
  activities: [{ name, description, types }]
}
```

**Model:** `@cf/bytedance/stable-diffusion-xl-lightning`

- **Style:** Flat, colorful, painting-like (no people/animals)
- **Layout:** Centered object with abstract background
- **Negative prompt:** "Avoid toys, scary elements, political statements, words"
- **Guidance:** 35 (high adherence to prompt)

**Storage:** R2 bucket at `users/{id}/profile.png`

## API Reference

All endpoints require Bearer authentication: `Authorization: Bearer {ADMIN_API_KEY}`

### Activities

| Method | Endpoint                   | Description                         | Cache TTL |
| ------ | -------------------------- | ----------------------------------- | --------- |
| GET    | `/v1/activity/:id`         | Generate/retrieve activity metadata | 12h       |
| GET    | `/v1/synonyms?word={word}` | Get synonyms for activity naming    | 12h       |

### Articles

| Method | Endpoint                                  | Description                | Cache TTL |
| ------ | ----------------------------------------- | -------------------------- | --------- |
| GET    | `/v1/articles/search?q={query}`           | Search scientific articles | None      |
| POST   | `/v1/articles/recommend_similar_articles` | Find similar articles      | 12h       |

### Users

| Method | Endpoint                         | Description                     | Cache TTL |
| ------ | -------------------------------- | ------------------------------- | --------- |
| POST   | `/v1/users/recommend_activities` | Recommend new activities        | None      |
| POST   | `/v1/users/recommend_articles`   | Recommend articles by interests | 12h       |
| GET    | `/v1/users/profile_photo/:id`    | Get profile photo (data URL)    | 12h       |
| PUT    | `/v1/users/profile_photo/:id`    | Generate new profile photo      | None      |

### User Journeys

| Method | Endpoint                                         | Description                     | Cache TTL |
| ------ | ------------------------------------------------ | ------------------------------- | --------- |
| GET    | `/v1/users/journey/:type/:id`                    | Get journey streak              | None      |
| POST   | `/v1/users/journey/:type/:id/increment`          | Increment streak (24h cooldown) | None      |
| GET    | `/v1/users/journey/activity/:id/count`           | Get activity completion count   | None      |
| POST   | `/v1/users/journey/activity/:id?activity={name}` | Add activity to journey         | None      |
| DELETE | `/v1/users/journey/:type/:id/delete`             | Reset journey                   | None      |

## AI Models & Prompting

### Model Selection Strategy

| Use Case                     | Model                                          | Rationale                              |
| ---------------------------- | ---------------------------------------------- | -------------------------------------- |
| **Activity Descriptions**    | `@cf/meta/llama-4-scout-17b-16e-instruct`      | Large context window, creative writing |
| **Activity Tags**            | `@cf/meta/llama-3.1-8b-instruct-fp8`           | Fast inference, structured output      |
| **Article Topics**           | `@cf/meta/llama-3.2-3b-instruct`               | Lightweight, single-word generation    |
| **Article Ranking**          | `@cf/baai/bge-reranker-base`                   | State-of-art semantic similarity       |
| **Article Titles/Summaries** | `@cf/mistralai/mistral-small-3.1-24b-instruct` | Long context, nuanced language         |
| **Prompts**                  | `@cf/openai/gpt-oss-120b`                      | Reasoning capabilities, creativity     |
| **Profile Photos**           | `@cf/bytedance/stable-diffusion-xl-lightning`  | Fast image generation (<5s)            |

### Output Sanitization

Comprehensive cleaning pipeline (`prompts.ts:sanitizeAIOutput`):

```typescript
1. Remove markdown (code blocks, bold, italic, headers)
2. Remove quotes and fancy characters
3. Remove AI prefixes ("Here's...", "The answer is...")
4. Collapse whitespace
5. Fix punctuation artifacts
6. Remove HTML tags
7. Content-type specific rules (title vs description vs topic)
```

## Caching Strategy

### Multi-Tier Architecture

```txt
┌──────────────────────────────────────┐
│   HTTP Cache (Hono Middleware)      │
│   Cache-Control: public, max-age=60 │
│   Vary: Accept-Encoding, Authorization
└──────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────┐
│   KV Cache (CACHE namespace)        │
│   TTL: 12 hours (43,200 seconds)    │
│   Serialization: JSON with custom    │
│   Uint8Array reviver/replacer        │
└──────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────┐
│   Source of Truth                    │
│   - AI model invocation              │
│   - External API calls               │
│   - Database queries                 │
└──────────────────────────────────────┘
```

### Cache Key Patterns

```typescript
// Deterministic keys with hash-based compression
`cache:activity_data:${id}``cache:synonyms:${word.toLowerCase()}``cache:similar_articles:${articleId}:${poolHash(36)}:${limit}``cache:recommended_articles:${activitiesHash(36)}:${poolHash(36)}:${limit}``user:profile_photo:${id}`
// Journey keys (persistent KV, not CACHE)
`journey:${type}:${id}` // type = 'article' | 'prompt'
`journey:activities:${id}`;
```

### Hash Function (DJB2 Variant)

```typescript
let hash = 0;
for (let i = 0; i < str.length; i++) {
	hash = ((hash << 5) - hash + str.charCodeAt(i)) & 0xffffffff;
}
return Math.abs(hash).toString(36); // Base-36 encoding
```

### Cache Invalidation

- **Explicit**: Not implemented (rely on TTL expiration)
- **Automatic**: 12-hour TTL for all cached data
- **Journey Renewal**: 2-day TTL extended on each increment (within 24h cooldown)

### Serialization Edge Cases

Custom JSON reviver/replacer for `Uint8Array`:

```typescript
JSON.stringify(value, (_, val) =>
	val instanceof Uint8Array ? { __type: 'Uint8Array', data: Array.from(val) } : val
);

JSON.parse(result, (_, val) => (val?.__type === 'Uint8Array' ? new Uint8Array(val.data) : val));
```

## Scheduled Tasks

Configured via `wrangler.jsonc`:

```jsonc
"triggers": {
  "crons": [
    "0 * * * *",     // Every hour (prompt generation)
    "0 */4 * * *"    // Every 4 hours (article creation)
  ]
}
```

### Hourly Task: Prompt Generation

1. Generate question using GPT-4 model
2. Validate (length, format, prohibited words)
3. POST /v2/prompts (Mantle API)

**Example Output:**

```json
{
	"id": "prompt_123",
	"prompt": "How does curiosity shape learning?",
	"visibility": "PUBLIC",
	"created_at": "2025-10-29T12:00:00Z"
}
```

### 4-Hourly Task: Article Creation

1. Generate topic (e.g., "mental health")
2. Select 3-5 random tags (ActivityType enum)
3. Search articles (PubMed + scrapers)
4. Rank candidates (semantic similarity)
5. Generate title + summary
6. POST /v2/articles (Mantle API)

**Example Output:**

```json
{
	"id": "article_456",
	"title": "The Neural Pathways of Resilience",
	"description": "Recent research explores how...",
	"tags": ["HEALTH", "SCIENCE", "SELF_IMPROVEMENT"],
	"content": "Paragraph 1...\n\nParagraph 2...",
	"ocean": {
		"title": "Neuroscience of Mental Health",
		"author": "Dr. Jane Smith",
		"source": "Journal of Psychology",
		"url": "https://example.com/article",
		"keywords": ["resilience", "neuroscience", "mental health"],
		"date": "2025-10-15"
	}
}
```

### Error Handling

```typescript
ctx.waitUntil(
	(async () => {
		try {
			// Task logic
		} catch (error) {
			console.error('Scheduled task failed:', error);
			// Does not throw (avoids Worker failure)
		}
	})()
);
```

## Development

### Prerequisites

- **Bun** (>= 1.0.0): `curl -fsSL https://bun.sh/install | bash`
- **Wrangler** (via Bun): Included in `devDependencies`
- **Cloudflare Account**: With Workers, KV, R2, AI enabled

### Local Development

```bash
# Install dependencies
bun install

# Start local development server (port 9898)
bun run dev

# Test endpoint
curl http://localhost:9898/v1/activity/hiking \
  -H "Authorization: Bearer YOUR_DEV_API_KEY"
```

### Debugging AI Models

Enable verbose logging:

```typescript
console.log('AI Request:', { model, messages, max_tokens });
const response = await ai.run(model, params);
console.log('AI Response:', response);
```

**Common Issues:**

- **Empty Response**: Check model availability in region
- **Validation Failure**: Inspect raw output before sanitization
- **Timeout**: Reduce context length or switch to smaller model

## Deployment

### Production Deployment

```bash
# Deploy to Cloudflare Workers
bun run deploy

# Deployment steps:
# 1. Minifies TypeScript with esbuild
# 2. Uploads to Cloudflare Workers
# 3. Applies wrangler.jsonc configuration
# 4. Activates on cloud.earth-app.com
```

---

## License

All Earth App components are available open-source.
This repository is licensed under the Apache 2.0 License.

The Earth App © 2025

## Contributors

Maintained by the Earth App development team.

For questions or support, contact: [support@earth-app.com](mailto:support@earth-app.com)
