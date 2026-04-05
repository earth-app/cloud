# cloud

> The Automaton behind The Earth App

A sophisticated Cloudflare Workers-based microservice that powers The Earth App's
AI-driven content generation, recommendations, events, realtime notifications,
and user progression systems. Built with Hono.js, this service orchestrates
multiple AI models, manages distributed caching, and exposes a comprehensive
REST + WebSocket API for activity discovery, article curation, quest tracking,
image submissions, and personalized recommendations.

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

The Cloud service is a serverless application running on Cloudflare Workers with
three primary runtime surfaces: REST APIs, WebSocket notification channels, and
scheduled automation.

```txt
┌─────────────────────────────────────────────────────────────────────┐
│                         Hono.js Edge Router                         │
│  ┌────────────────┐  ┌────────────────┐  ┌──────────────────────┐   │
│  │ Middleware     │  │ API /v1        │  │ API /ws              │   │
│  │ - Security     │  │ - Activities   │  │ - Ticket issuance    │   │
│  │ - CORS         │  │ - Articles     │  │ - Live notifications │   │
│  │ - Logger       │  │ - Events       │  │ - Admin push         │   │
│  │ - HTTP cache   │  │ - Quests       │  │                      │   │
│  └────────────────┘  │ - Badges/Points│  └──────────────────────┘   │
│                      │ - Journeys     │                             │
│                      └────────────────┘                             │
│                    Scheduled Worker (cron triggers)                 │
└─────────────────────────────────────────────────────────────────────┘
               │                 │                 │
               ▼                 ▼                 ▼
     ┌────────────────┐  ┌───────────────┐  ┌────────────────────┐
     │ Cloudflare AI  │  │ KV + Cache KV │  │ R2 + Images Binding│
     └────────────────┘  └───────────────┘  └────────────────────┘
                         ┌──────────────────────────────────────────┐
                         │ Durable Objects                          │
                         │ - LiveNotifier (WebSocket fan-out)       │
                         │ - UserTimer (user timer actions)         │
                         └──────────────────────────────────────────┘
```

### Request Flow

1. **Incoming request** -> middleware stack (headers, CORS, logging, cache)
2. **Authentication** ->
   - `/v1/*`: `Authorization: Bearer {ADMIN_API_KEY}`
   - `/ws/notify`: admin key
   - `/ws/users/:id/ticket`: user session token validation with Mantle
3. **Cache lookup** -> deterministic key checks in `CACHE` namespace
4. **Business logic** -> AI invocation, ranking, validation, KV/R2 reads+writes
5. **Response** -> JSON or binary response with custom headers

## Technology Stack

### Core Dependencies

- **hono** (`^4.12.10`): edge-optimized HTTP framework and middleware routing.
- **@earth-app/ocean** (`^1.0.4`): Kotlin/WASM library for article/event search and activity recommendations.
- **@earth-app/moho** (`^1.0.1`): calendar/event data source used for scheduled event generation.
- **pako** (`^2.1.0`): compression support (`nodejs_zlib`).
- **exifreader** (`^4.37.0`): EXIF parsing for event image metadata workflows.
- **music-metadata** (`^11.12.3`): audio metadata utilities for media processing.
- **@cloudflare/workerd-darwin-arm64** (`^1.20260405.1`): local runtime binary support while developing on Apple Silicon.

### Type Strategy

- Runtime/Worker types are generated with Wrangler into `src/worker-configuration.d.ts`.
- `@cloudflare/workers-types` has been removed from dependencies and `tsconfig.json`.

### Development Tools

- **Wrangler** (^4.80.0): local dev, deploy, and type generation
- **Vitest** (^4.1.2) + **@cloudflare/vitest-pool-workers** (^0.14.1): worker-native tests
- **Prettier** (^3.8.1): formatting with Husky + lint-staged
- **Bun**: package/runtime tooling

## Infrastructure & Bindings

The service integrates with Cloudflare services via Worker bindings:

```typescript
type Bindings = {
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
```

### Cloudflare KV Namespaces

- **CACHE** (`c4a1aaf2a5fc4be98b91df2d0fc0faab`): ephemeral cache (12-hour default TTL)
  - Activity metadata and synonyms
  - Article/event recommendation results
  - Scoring results
  - Leaderboards and profile photo responses

- **KV** (`322faefd5628471cb7cea08cf041804a`): persistent and semi-persistent app state
  - Journey streaks and activity completion logs
  - Badge progress + grant metadata
  - Impact points history
  - Quest progress/history metadata
  - Event submission indices and score metadata

### R2 Bucket

- **Bucket**: `earth-app` (prod)
- **Primary objects**:
  - `users/{id}/profile.png` and resized variants
  - `events/{eventId}/thumbnail.webp`
  - `events/{eventId}/submissions/{userId}_{submissionId}.webp` (encrypted)
  - `users/{id}/quests/{questId}/...` binary quest evidence (compressed + encrypted)

### Durable Objects

- **LiveNotifier** (`NOTIFIER`):
  - Issues one-time WebSocket tickets
  - Enforces one-time ticket consumption with transactional storage
  - Fans out pushed notifications to connected sockets

- **UserTimer** (`TIMER`):
  - Tracks per-user timer actions (`start`/`stop`)
  - Applies duration-based progress updates (e.g., reading-time trackers)

### External Services

- NCBI PubMed APIs (article search)
- Iconify API (activity icon resolution)
- Dictionary API (activity synonyms)
- Google Places + Geocoding APIs (event thumbnail lookup/reverse geocode)
- Mantle backend API (`MANTLE_URL`) for persistence integration

## Core Features

### 1. Dynamic Activity Generation

`GET /v1/activity/:id` generates and caches activity metadata:

- AI-generated 200+ character descriptions with retry + validation
- Activity type classification
- Synonym enrichment
- Icon lookup from preferred icon sets

### 2. Scientific Article Curation + Quiz Generation

Automated article pipeline:

1. Generate a topic
2. Search source articles via Ocean scrapers
3. Rank with semantic reranker
4. Build polished title + summary
5. Generate 2-5 quiz questions
6. Publish to Mantle and cache quiz payload

Scheduled article creation now generates **two pieces per run** (best-ranked and worst-ranked)
to improve diversity.

### 3. Multi-Domain Recommendations

- **Articles**: `POST /v1/users/recommend_articles`
- **Similar Articles**: `POST /v1/articles/recommend_similar_articles`
- **Activities**: `POST /v1/users/recommend_activities`
- **Events**: `POST /v1/users/recommend_events`
- **Similar Events**: `POST /v1/events/recommend_similar_events`

All recommendation paths use AI ranking with deterministic cache keys and fallback behavior.

### 4. User Journeys + Leaderboards

Tracks streaks for `article`, `prompt`, and `event` journeys with:

- 24-hour increment cooldown
- 2-day rolling TTL renewal
- Cached top leaderboard snapshots
- Rank lookup endpoint
- Separate permanent activity completion logs

### 5. Badges, Impact Points, and Timers

User progression includes:

- Rule-based badge tracking and granting
- Manual admin operations (grant/revoke/reset)
- Impact point accounting with history
- Timer-driven tracker updates through Durable Object actions

### 6. Quest Engine (Multimodal)

Quest steps support image, audio, article quiz, and structured interactions:

- Binary quest artifacts are compressed + encrypted before R2 storage
- Per-step delay windows and alternate step handling
- Completed quest archiving + retrieval
- Quest progress enrichment with generated data URLs for retrieval APIs

### 7. Event Creation + Thumbnail Automation

Every 2 days, the worker generates events from Moho calendar data.

- Birthday-style events are parsed for location extraction
- Place photos are discovered with Google Places APIs
- Thumbnails are converted to WebP, stored in R2, and exposed via metadata-rich endpoints
- Event creation continues even when thumbnail generation fails (best-effort resilience)

### 8. Event Image Submissions + Scoring

Users can submit event images (data URL payloads), then retrieve scored results:

- Image normalization/transforms via Images binding
- Encrypted object storage in R2
- Score + caption generation via AI rubric
- Query endpoints for submission lookup, pagination, filtering, and deletion

### 9. Realtime WebSocket Notifications

WebSocket flow under `/ws`:

1. Client requests a one-time ticket (`/ws/users/:id/ticket`)
2. Ticket is validated and consumed on connect (`/ws/users/:id/notifications?ticket=...`)
3. Backend/admin sends payloads through `/ws/notify`

Security details include no-store headers, masked ticket logging, and strict one-time semantics.

### 10. AI-Generated Profile Photos

`PUT /v1/users/profile_photo/:id` generates a profile image and asynchronously creates
size variants (`32`, `128`, original) with Images binding + R2 persistence.

## API Reference

### Auth Model

- All `/v1/*` endpoints require `Authorization: Bearer {ADMIN_API_KEY}`.
- `/ws/notify` also requires admin bearer auth.
- WebSocket user channels use session-validated one-time tickets (not admin keys).

### Root

| Method | Endpoint | Description             |
| ------ | -------- | ----------------------- |
| GET    | `/`      | Health check (`Woosh!`) |

### Admin

| Method | Endpoint                        | Description                    |
| ------ | ------------------------------- | ------------------------------ |
| POST   | `/v1/admin/migrate-legacy-keys` | Migrates legacy KV key formats |

### Activities

| Method | Endpoint                   | Description                           |
| ------ | -------------------------- | ------------------------------------- |
| GET    | `/v1/activity/:id`         | Generate/retrieve activity metadata   |
| GET    | `/v1/synonyms?word={word}` | Retrieve synonyms for naming/aliasing |

### Articles

| Method | Endpoint                                             | Description                       |
| ------ | ---------------------------------------------------- | --------------------------------- |
| GET    | `/v1/articles/search?q={query}`                      | Search article sources            |
| POST   | `/v1/articles/recommend_similar_articles`            | Similar article recommendations   |
| POST   | `/v1/articles/grade`                                 | AI rubric score for article text  |
| POST   | `/v1/articles/quiz/create`                           | Generate and persist article quiz |
| GET    | `/v1/articles/quiz?articleId={id}`                   | Fetch article quiz                |
| POST   | `/v1/articles/quiz/submit`                           | Submit user quiz answers          |
| GET    | `/v1/articles/quiz/score?userId={id}&articleId={id}` | Fetch saved quiz score            |

### Prompts

| Method | Endpoint            | Description                     |
| ------ | ------------------- | ------------------------------- |
| POST   | `/v1/prompts/grade` | AI rubric score for prompt text |

### User Recommendations + Profiles

| Method | Endpoint                                           | Description                           |
| ------ | -------------------------------------------------- | ------------------------------------- |
| POST   | `/v1/users/recommend_activities`                   | Activity recommendations              |
| POST   | `/v1/users/recommend_articles`                     | Article recommendations by activities |
| POST   | `/v1/users/recommend_events`                       | Event recommendations by activities   |
| GET    | `/v1/users/profile_photo/:id?size={32\|128\|1024}` | Retrieve profile photo variant        |
| PUT    | `/v1/users/profile_photo/:id`                      | Generate/replace profile photo        |
| POST   | `/v1/users/timer`                                  | Timer Durable Object actions          |

### Journeys

| Method | Endpoint                                         | Description                          |
| ------ | ------------------------------------------------ | ------------------------------------ |
| GET    | `/v1/users/journey/:type/:id`                    | Get journey streak + rank            |
| POST   | `/v1/users/journey/:type/:id/increment`          | Increment streak with cooldown logic |
| DELETE | `/v1/users/journey/:type/:id/delete`             | Reset streak                         |
| GET    | `/v1/users/journey/:type/leaderboard?limit={n}`  | Get top leaderboard                  |
| GET    | `/v1/users/journey/:type/:id/rank`               | Get user rank                        |
| GET    | `/v1/users/journey/activity/:id/count`           | Count completed activities           |
| POST   | `/v1/users/journey/activity/:id?activity={name}` | Add completed activity               |

### Badges

| Method | Endpoint                                  | Description                        |
| ------ | ----------------------------------------- | ---------------------------------- |
| GET    | `/v1/users/badges`                        | List badge catalog                 |
| GET    | `/v1/users/badges/:id`                    | List user's badge states           |
| GET    | `/v1/users/badges/:id/:badge_id`          | Get single badge state             |
| POST   | `/v1/users/badges/:id/track`              | Track badge progress by tracker ID |
| POST   | `/v1/users/badges/:id/:badge_id/progress` | Add progress for badge tracker     |
| POST   | `/v1/users/badges/:id/:badge_id/grant`    | Manually grant one-time badge      |
| DELETE | `/v1/users/badges/:id/:badge_id/revoke`   | Revoke granted badge               |
| DELETE | `/v1/users/badges/:id/:badge_id/reset`    | Reset badge progress               |

### Impact Points

| Method | Endpoint                             | Description          |
| ------ | ------------------------------------ | -------------------- |
| GET    | `/v1/users/impact_points/:id`        | Get points + history |
| POST   | `/v1/users/impact_points/:id/add`    | Add points           |
| POST   | `/v1/users/impact_points/:id/remove` | Remove points        |
| PUT    | `/v1/users/impact_points/:id/set`    | Set absolute points  |

### Quests

| Method | Endpoint                                              | Description                 |
| ------ | ----------------------------------------------------- | --------------------------- |
| GET    | `/v1/users/quests`                                    | List quest definitions      |
| GET    | `/v1/users/quests/:id`                                | Get quest definition        |
| POST   | `/v1/users/quests/progress/:user_id`                  | Start quest                 |
| PATCH  | `/v1/users/quests/progress/:user_id`                  | Submit step response        |
| GET    | `/v1/users/quests/progress/:user_id`                  | Get active progress         |
| GET    | `/v1/users/quests/progress/:user_id/step/:step_index` | Get specific step progress  |
| DELETE | `/v1/users/quests/progress/:user_id`                  | Reset active progress       |
| GET    | `/v1/users/quests/history/:user_id`                   | List completed quests       |
| GET    | `/v1/users/quests/history/:user_id/:quest_id`         | Get completed quest payload |

### Events + Event Media

| Method | Endpoint                                              | Description                                        |
| ------ | ----------------------------------------------------- | -------------------------------------------------- |
| GET    | `/v1/events/thumbnail/:id`                            | Get event thumbnail image                          |
| GET    | `/v1/events/thumbnail/:id/metadata`                   | Get thumbnail author + size metadata               |
| POST   | `/v1/events/thumbnail/:id`                            | Upload custom thumbnail                            |
| POST   | `/v1/events/thumbnail/:id/generate?name={event_name}` | Generate location-based thumbnail                  |
| DELETE | `/v1/events/thumbnail/:id`                            | Delete event thumbnail                             |
| POST   | `/v1/events/recommend_similar_events`                 | Similar event recommendations                      |
| POST   | `/v1/events/submit_image`                             | Submit event image                                 |
| GET    | `/v1/events/retrieve_image?...`                       | Retrieve image submission(s) with optional filters |
| DELETE | `/v1/events/delete_image?...`                         | Delete one or many image submissions               |

### WebSocket Routes

| Method | Endpoint                                    | Description                                         |
| ------ | ------------------------------------------- | --------------------------------------------------- |
| POST   | `/ws/notify`                                | Admin push payload to a channel                     |
| GET    | `/ws/users/:id/ticket`                      | Issue one-time WebSocket ticket (session validated) |
| GET    | `/ws/users/:id/notifications?ticket={uuid}` | Upgrade to user notification WebSocket              |

## AI Models & Prompting

### Model Selection Strategy

| Use Case                           | Model                                          | Rationale                           |
| ---------------------------------- | ---------------------------------------------- | ----------------------------------- |
| Activity descriptions              | `@cf/meta/llama-4-scout-17b-16e-instruct`      | Rich descriptive generation         |
| Activity tags                      | `@cf/meta/llama-3.1-8b-instruct-fp8`           | Fast structured tagging             |
| Article topic generation           | `@cf/meta/llama-3.2-3b-instruct`               | Lightweight topic selection         |
| Semantic ranking (articles/events) | `@cf/baai/bge-reranker-base`                   | Strong reranking quality            |
| Article title + summary            | `@cf/mistralai/mistral-small-3.1-24b-instruct` | Long-form summarization quality     |
| Article quiz generation            | `@cf/meta/llama-4-scout-17b-16e-instruct`      | Reliable structured question output |
| Prompt generation                  | `@cf/openai/gpt-oss-120b`                      | Higher-order prompt reasoning       |
| Profile photo generation           | `@cf/bytedance/stable-diffusion-xl-lightning`  | Fast image synthesis                |
| Text embeddings for scoring        | `@cf/baai/bge-m3`                              | Semantic similarity scoring         |
| Image captioning for scoring       | `@cf/llava-hf/llava-1.5-7b-hf`                 | Visual-to-text interpretation       |
| Image classification               | `@cf/microsoft/resnet-50`                      | Label confidence checks             |
| Object detection                   | `@cf/facebook/detr-resnet-50`                  | Object-level validation             |
| Audio transcription                | `@cf/openai/whisper-large-v3-turbo`            | Quest audio validation              |

### Output Sanitization

`src/util/ai.ts` includes a centralized sanitation/validation pipeline:

1. Remove markdown artifacts and wrappers
2. Remove common AI prefixes and formatting noise
3. Normalize whitespace and punctuation
4. Apply content-type-specific cleanup (`description`, `title`, `topic`, `tags`, `question`)
5. Enforce strict validators per domain object

## Caching Strategy

### Multi-Tier Architecture

```txt
┌──────────────────────────────────────┐
│ HTTP Cache Middleware               │
│ Scope: /v1/*                        │
│ Cache-Control: public, max-age=60   │
└──────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────┐
│ KV Cache (CACHE namespace)          │
│ Default TTL: 12h                    │
│ Includes Uint8Array custom serializer│
└──────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────┐
│ Source of Truth                      │
│ AI + External APIs + KV/R2           │
└──────────────────────────────────────┘
```

### Key Patterns

```typescript
// Activities and synonyms
`cache:activity_data:${id}``cache:synonyms:${word.toLowerCase()}`
// Recommendations
`cache:recommended_articles:${activitiesHash}:${poolHash}:${limit}``cache:similar_articles:${articleId}:${poolHash}:${limit}``cache:recommended_events:${activitiesHash}:${poolHash}:${limit}``cache:similar_events:${eventId}:${poolHash}:${limit}`
// Scoring and profile
`cache:article_score:${id}``cache:prompt_score:${id}``user:profile_photo:${id}:${size}`
// Journey + leaderboard
`journey:${type}:${id}``journey:activities:${id}``leaderboard:${type}`;
```

### TTL Notes

- Default cache TTL: **12 hours**
- Leaderboard cache TTL: **4 hours**
- Article score cache: **14 days**
- Prompt score cache: **2 days**
- Article quiz cache: **about 14 days**
- Journey streak keys in KV: **2-day TTL**, renewed by activity
- `/ws/*` routes explicitly use `no-store` semantics

### Serialization Edge Cases

Custom reviver/replacer handles binary payloads:

```typescript
JSON.stringify(value, (_, val) =>
	val instanceof Uint8Array ? { __type: 'Uint8Array', data: Array.from(val) } : val
);

JSON.parse(result, (_, val) => (val?.__type === 'Uint8Array' ? new Uint8Array(val.data) : val));
```

## Scheduled Tasks

Configured in `wrangler.jsonc`:

```jsonc
"triggers": {
  "crons": [
    "0 * * * *",      // Hourly: cache journey leaderboards
    "*/12 * * * *",   // Every 12 minutes: create prompt
    "*/24 * * * *",   // Every 24 minutes: create best+worst ranked articles
    "0 0 */2 * *"     // Every 2 days: create events from calendar data
  ]
}
```

### Hourly: Leaderboard Cache

- Refreshes top rankings for `article`, `prompt`, and `event` journeys.

### Every 12 Minutes: Prompt Generation

1. Generate one validated question prompt
2. Publish to Mantle (`/v2/prompts`)

### Every 24 Minutes: Article Pair Generation

1. Generate topic and tags
2. Search + rank source articles
3. Create and post **two** article variants (best-ranked and worst-ranked)
4. Generate and attach quizzes

### Every 2 Days: Event Generation

1. Load upcoming events from Moho data
2. Create event payloads and post to Mantle
3. Attempt birthday-location thumbnail generation when applicable
4. Continue processing even when individual event creation fails

## Development

### Prerequisites

- **Bun** (>= 1.0.0)
- **Wrangler** (installed via project dependencies)
- Cloudflare account with Workers, KV, R2, AI, Images, and Durable Objects enabled

### Local Development

```bash
# Install dependencies
bun install

# Start local dev server (port 9898, scheduled testing enabled)
bun run dev

# Test endpoint
curl http://localhost:9898/v1/activity/hiking \
  -H "Authorization: Bearer YOUR_DEV_API_KEY"
```

### Testing

```bash
# Run worker tests
bunx vitest
```

### Regenerate Worker Types

```bash
# Regenerate runtime types used by TypeScript
bunx wrangler types
```

### Debugging AI Calls

```typescript
console.log('AI Request:', { model, messages });
const response = await ai.run(model, params);
console.log('AI Response:', response);
```

Common issues:

- Empty response: model availability or payload mismatch
- Validation failure: inspect raw output before sanitation
- Timeout: reduce context size or choose a lighter model

## Deployment

### Production Deployment

```bash
# Deploy to Cloudflare Workers
bun run deploy
```

Deployment flow:

1. Build/minify worker bundle
2. Upload worker + bindings config
3. Apply route + cron configuration from `wrangler.jsonc`
4. Activate on `cloud.earth-app.com`

---

## License

All Earth App components are available open-source.
This repository is licensed under the Apache 2.0 License.

The Earth App (c) 2025

## Contributors

Maintained by the Earth App development team.

For questions or support, contact: [support@earth-app.com](mailto:support@earth-app.com)
