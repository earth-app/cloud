# cloud

The Cloud service is the Earth App's Cloudflare Workers backend. It is built with Hono and exposes REST APIs, WebSocket flows, and scheduled automation for content generation, quest progress, event creation, image scoring, notifications, and user progression.

## Project Map

- `src/app.ts` - main Hono router, auth, route wiring, and API surface.
- `src/scheduled.ts` - cron-triggered automation for events, articles, and other scheduled tasks.
- `src/content/boat.ts` - AI-backed content generation, article discovery, recommendation logic, and event creation helpers.
- `src/content/ferry.ts` - AI scoring helpers for text, images, and audio plus classification/object detection.
- `src/user/timer.ts` - Durable Object-backed timer flow that applies reading-time progress and can advance quest steps.
- `src/user/quests/validation.ts` - quest response validation, device metadata checks, and anti-spoofing logic.
- `src/util/ai.ts` - prompt/output sanitization, schema validation helpers, and text normalization used by AI flows.
- `src/util/types.ts` - shared bindings, runtime types, and core domain types used across the worker.
- `tests/` - Vitest coverage mirrored to `src/`; prefer focused tests close to the touched behavior.

## External Integration

- `earth-app/mantle2` is the primary upstream consumer. Its PHP helpers call this worker through `CloudHelper::sendRequest(...)` and expect stable `/v1` route shapes, status codes, and JSON payloads.
- Keep Cloud and Mantle2 changes in sync for quests, impact points, events, thumbnails, quizzes, notifications, profile photos, and user progression. Many payloads are mirrored by shared schema assumptions on both sides.
- Quest response shapes are especially sensitive: `QuestStep`, `QuestProgressEntry`, `QuestData`, and the validation rules in `src/user/quests/validation.ts` must stay compatible with Mantle2 quest creation and progress tracking.
- Event and article workflows also have mirrored expectations in Mantle2. If you change event, quiz, or submission payloads, check the corresponding consumer before finishing the change.

## Working Rules

- Before changing API shapes, route names, or response fields, inspect the related test coverage and the Mantle2 call sites that consume the endpoint.
- Prefer the smallest targeted edit that preserves existing contract behavior.
- Use `apply_patch` for manual file edits.
- After edits, validate with the narrowest useful command first, usually a focused test or formatting check.
- Do not make unrelated cleanup changes while working on a targeted fix.
- Consolidate a domain's logic (and its tests) into that domain's file rather than splitting it out — e.g. the impact-points leaderboard lives in `src/user/points.ts` / `tests/user/points.spec.ts`, not a separate `leaderboard.ts`. Genuinely distinct domains (quests, badge mastery) keep their own files.

## Common Commands

- `bunx wrangler dev --port 9898 --test-scheduled` - run the worker locally.
- `bunx vitest run` - run the full test suite.
- `bunx vitest run --coverage` - run tests with coverage.
- `bunx prettier --write .` - format the repository.
- `bunx wrangler deploy --minify` - deploy the worker.

## Notes

- `/v1/*` routes are admin-authenticated with `ADMIN_API_KEY`.
- WebSocket ticket issuance and consumption use Durable Objects and one-time semantics.
- Many event and media operations are best-effort by design; non-critical thumbnail or enrichment failures should not break the main request.
- Quest validation intentionally rejects suspicious device, media, or metadata combinations rather than trusting client-provided results.
