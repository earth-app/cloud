import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	getAllTrails,
	getTrail,
	isTrailLocked,
	trailToQuest,
	isoWeekKey,
	getNatureMinutes,
	addNatureMinutes,
	NATURE_MINUTES_TARGET,
	TRAIL_QUEST_ID_PREFIX
} from '../../src/user/trails';
import { getQuest } from '../../src/user/quests';
import { createMockBindings } from '../helpers/mock-bindings';
import { callApp } from '../helpers/call-app';

describe('trail catalog', () => {
	it('every trail id carries the trail prefix and non-empty valid steps', () => {
		const all = getAllTrails();
		expect(all.length).toBeGreaterThan(0);
		for (const t of all) {
			expect(t.id.startsWith(TRAIL_QUEST_ID_PREFIX)).toBe(true);
			expect(t.steps.length).toBeGreaterThan(0);
			for (const s of t.steps) {
				expect(typeof s.clue).toBe('string');
				expect(typeof s.reveal).toBe('string');
				expect(typeof s.step.type).toBe('string');
			}
		}
	});

	it('getTrail resolves a known id and returns null for an unknown one', () => {
		expect(getTrail('trail_dawn_chorus')?.title).toBe('Dawn Chorus');
		expect(getTrail('trail_nope')).toBeNull();
	});

	it('locks premium and seasonal trails, leaves the core set free', () => {
		const premium = getAllTrails().find((t) => t.premium);
		const seasonal = getAllTrails().find((t) => t.seasonal);
		const normal = getAllTrails().find((t) => !t.premium && !t.seasonal);
		expect(isTrailLocked(premium!)).toBe(true);
		expect(isTrailLocked(seasonal!)).toBe(true);
		expect(isTrailLocked(normal!)).toBe(false);
	});
});

describe('trailToQuest', () => {
	it('projects a trail onto the quest shape and mirrors the lock as premium', () => {
		const trail = getTrail('trail_night_sky')!; // premium
		const quest = trailToQuest(trail);
		expect(quest.id).toBe(trail.id);
		expect(quest.title).toBe(trail.title);
		expect(quest.reward).toBe(trail.reward);
		expect(quest.steps.length).toBe(trail.steps.length);
		expect(quest.premium).toBe(true);
	});

	it('derives permissions from the underlying step types', () => {
		const quest = trailToQuest(getTrail('trail_dawn_chorus')!);
		// dawn chorus has photo steps (camera) and a distance step (motion)
		expect(quest.permissions).toContain('camera');
		expect(quest.permissions).toContain('motion');
	});

	it('the quest engine resolves trail_* ids through getQuest', async () => {
		const bindings = createMockBindings();
		const quest = await getQuest('trail_texture_hunt', bindings);
		expect(quest?.id).toBe('trail_texture_hunt');
		expect(await getQuest('trail_does_not_exist', bindings)).toBeNull();
	});
});

describe('isoWeekKey', () => {
	it('is deterministic and thursday-anchored', () => {
		expect(isoWeekKey(new Date('2026-01-01T12:00:00Z'))).toBe('2026-W01');
		// jan 1 2016 (fri) belongs to iso week 53 of 2015
		expect(isoWeekKey(new Date('2016-01-01T12:00:00Z'))).toBe('2015-W53');
		const d = new Date('2026-07-17T00:00:00Z');
		expect(isoWeekKey(d)).toBe(isoWeekKey(d));
	});
});

describe('nature minutes', () => {
	let env: ReturnType<typeof createMockBindings>;

	beforeEach(() => {
		env = createMockBindings();
	});

	it('returns an empty personal ring by default', async () => {
		const nm = await getNatureMinutes(env, '42');
		expect(nm.minutes).toBe(0);
		expect(nm.best).toBe(0);
		expect(nm.target).toBe(NATURE_MINUTES_TARGET);
		expect(nm.sources).toEqual([]);
	});

	it('credits minutes and appends a source', async () => {
		const nm = await addNatureMinutes(env, '42', 30, 'trail_step', 'trail_dawn_chorus');
		expect(nm.minutes).toBe(30);
		expect(nm.best).toBe(30);
		expect(nm.sources[0]).toMatchObject({
			kind: 'trail_step',
			minutes: 30,
			ref_id: 'trail_dawn_chorus'
		});
	});

	it('clamps a negative credit to zero and an absurd credit to one day', async () => {
		await addNatureMinutes(env, '7', -100, 'manual');
		let nm = await getNatureMinutes(env, '7');
		expect(nm.minutes).toBe(0);

		nm = await addNatureMinutes(env, '7', 999999, 'manual');
		expect(nm.minutes).toBe(24 * 60);
	});

	it('falls back to manual for an unknown source kind', async () => {
		const nm = await addNatureMinutes(env, '9', 10, 'bogus' as never);
		expect(nm.sources[0].kind).toBe('manual');
	});

	it('persists the all-time best so it survives a week rollover', async () => {
		await addNatureMinutes(env, '5', 90, 'quest');
		// a different (future) week starts empty but keeps the persisted best
		const other = await getNatureMinutes(env, '5', '2099-W01');
		expect(other.minutes).toBe(0);
		expect(other.best).toBe(90);
	});

	it('normalizes a padded uid to the same ring', async () => {
		await addNatureMinutes(env, '0042', 15, 'healthkit');
		const nm = await getNatureMinutes(env, '42');
		expect(nm.minutes).toBe(15);
	});
});

// ---- routes ----------------------------------------------------------------

describe('trail + nature-minutes routes', () => {
	afterEach(() => vi.restoreAllMocks());

	it('rejects unauthenticated requests', async () => {
		const { response } = await callApp('/trails', {}, false);
		expect(response.status).toBe(401);
	});

	it('GET /v1/trails returns the full catalog', async () => {
		const { response } = await callApp('/trails');
		expect(response.status).toBe(200);
		const body = (await response.json()) as unknown[];
		expect(Array.isArray(body)).toBe(true);
		expect(body.length).toBe(getAllTrails().length);
	});

	it('GET /v1/trails/:id resolves a trail and 404s an unknown id', async () => {
		const ok = await callApp('/trails/trail_dawn_chorus');
		expect(ok.response.status).toBe(200);
		const missing = await callApp('/trails/trail_missing');
		expect(missing.response.status).toBe(404);
	});

	it('GET /v1/trails/:id gates a premium trail for a free rank', async () => {
		const { response } = await callApp('/trails/trail_night_sky?rank=free');
		expect(response.status).toBe(403);
		const pro = await callApp('/trails/trail_night_sky?rank=pro');
		expect(pro.response.status).toBe(200);
	});

	it('GET /v1/users/nature-minutes requires a valid uid', async () => {
		const bad = await callApp('/users/nature-minutes');
		expect(bad.response.status).toBe(400);
		const ok = await callApp('/users/nature-minutes?uid=42');
		expect(ok.response.status).toBe(200);
	});

	it('POST /v1/users/nature-minutes credits the ring', async () => {
		const bindings = createMockBindings();
		const post = await callApp(
			'/users/nature-minutes',
			{ method: 'POST', body: JSON.stringify({ uid: '42', minutes: 25, kind: 'trail_step' }) },
			true,
			bindings
		);
		expect(post.response.status).toBe(200);
		const body = (await post.response.json()) as { minutes: number };
		expect(body.minutes).toBe(25);

		const get = await callApp('/users/nature-minutes?uid=42', {}, true, bindings);
		const ring = (await get.response.json()) as { minutes: number };
		expect(ring.minutes).toBe(25);
	});

	it('POST /v1/users/nature-minutes rejects non-positive minutes', async () => {
		const { response } = await callApp('/users/nature-minutes', {
			method: 'POST',
			body: JSON.stringify({ uid: '42', minutes: 0 })
		});
		expect(response.status).toBe(400);
	});
});
