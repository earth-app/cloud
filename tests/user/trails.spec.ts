import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	getAllTrails,
	getTrail,
	isTrailLocked,
	isoWeekKey,
	getNatureMinutes,
	addNatureMinutes,
	NATURE_MINUTES_TARGET,
	startTrailRun,
	completeTrailRun,
	getTrailRun,
	getTrailJournal,
	journalCap
} from '../../src/user/trails';
import { createMockBindings } from '../helpers/mock-bindings';
import { callApp } from '../helpers/call-app';

describe('trail catalog', () => {
	it('every trail is a practice-based standalone trail with curiosity + reveal', () => {
		const all = getAllTrails();
		expect(all.length).toBeGreaterThanOrEqual(8);
		const practices = new Set<string>();
		for (const t of all) {
			expect(typeof t.id).toBe('string');
			expect(typeof t.practice).toBe('string');
			expect(t.curiosity.length).toBeGreaterThan(0);
			expect(t.reflectionPrompt.length).toBeGreaterThan(0);
			expect(t.reveal.length).toBeGreaterThan(0);
			expect(t.duration).toBeGreaterThan(0);
			// no quest projection leaks onto the standalone trail shape
			expect((t as unknown as Record<string, unknown>).steps).toBeUndefined();
			expect((t as unknown as Record<string, unknown>).reward).toBeUndefined();
			practices.add(t.practice);
		}
		// the catalog spans several distinct qualitative practices
		expect(practices.size).toBeGreaterThanOrEqual(6);
	});

	it('getTrail resolves a known id and returns null for an unknown one', () => {
		expect(getTrail('trail_sit_spot')?.title).toBe('The Sit Spot');
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

	it('journalCap grows with a paid rank', () => {
		expect(journalCap('free')).toBe(20);
		expect(journalCap(undefined)).toBe(20);
		expect(journalCap(null)).toBe(20);
		expect(journalCap('pro')).toBe(100);
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

	it('credits minutes and appends a trail source', async () => {
		const nm = await addNatureMinutes(env, '42', 30, 'trail', 'trail_sit_spot');
		expect(nm.minutes).toBe(30);
		expect(nm.best).toBe(30);
		expect(nm.sources[0]).toMatchObject({
			kind: 'trail',
			minutes: 30,
			ref_id: 'trail_sit_spot'
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

describe('trail runs + journal', () => {
	let env: ReturnType<typeof createMockBindings>;
	beforeEach(() => {
		env = createMockBindings();
	});

	it('start then complete records a journal entry and credits nature minutes as trail', async () => {
		const run = await startTrailRun(env, '42', 'trail_sit_spot', {
			when: 'after lunch',
			where: 'the park'
		});
		expect(run.completed).toBe(false);
		expect(run.presenceMinutes).toBe(0);
		expect(run.pledge?.when).toBe('after lunch');
		expect(run.pledge?.where).toBe('the park');

		const stored = await getTrailRun(env, '42', 'trail_sit_spot');
		expect(stored?.trailId).toBe('trail_sit_spot');

		const result = await completeTrailRun(
			env,
			'42',
			'trail_sit_spot',
			15,
			{ note: 'so quiet', mood: 'calm', photoCount: 2, sharedToGarden: true },
			journalCap('free')
		);
		expect(result).not.toBeNull();
		if (!result) return;
		expect(result.run.completed).toBe(true);
		expect(result.run.presenceMinutes).toBe(15);
		// the run keeps the pledge captured at start
		expect(result.run.pledge?.when).toBe('after lunch');
		expect(result.entry.title).toBe('The Sit Spot');
		expect(result.entry.practice).toBe('sit_spot');
		expect(result.entry.reflection.note).toBe('so quiet');
		expect(result.entry.reflection.mood).toBe('calm');
		expect(result.entry.reflection.photoCount).toBe(2);
		expect(result.entry.reflection.sharedToGarden).toBe(true);
		expect(result.natureMinutes.minutes).toBe(15);
		expect(result.natureMinutes.sources[0].kind).toBe('trail');
		expect(result.natureMinutes.sources[0].ref_id).toBe('trail_sit_spot');

		const journal = await getTrailJournal(env, '42', journalCap('free'));
		expect(journal.length).toBe(1);
		expect(journal[0].trailId).toBe('trail_sit_spot');
	});

	it('clamps presence minutes to 0..180 and drops an invalid mood', async () => {
		const over = await completeTrailRun(
			env,
			'7',
			'trail_sit_spot',
			999,
			{ mood: 'ecstatic' as never },
			journalCap('free')
		);
		expect(over?.run.presenceMinutes).toBe(180);
		expect(over?.entry.reflection.mood).toBeUndefined();

		const neg = await completeTrailRun(env, '7', 'trail_sit_spot', -5, {}, journalCap('free'));
		expect(neg?.run.presenceMinutes).toBe(0);
	});

	it('completeTrailRun returns null for an unknown trail', async () => {
		expect(await completeTrailRun(env, '7', 'trail_nope', 10, {}, 20)).toBeNull();
	});

	it('caps the free journal at 20 while a paid rank keeps more', async () => {
		for (let i = 0; i < 25; i++) {
			await completeTrailRun(
				env,
				'42',
				'trail_sit_spot',
				10,
				{ note: `n${i}` },
				journalCap('free')
			);
		}
		const free = await getTrailJournal(env, '42', journalCap('free'));
		expect(free.length).toBe(20);
		// most-recent first: the last write leads the journal
		expect(free[0].reflection.note).toBe('n24');

		const env2 = createMockBindings();
		for (let i = 0; i < 25; i++) {
			await completeTrailRun(
				env2,
				'42',
				'trail_sit_spot',
				10,
				{ note: `p${i}` },
				journalCap('pro')
			);
		}
		const premium = await getTrailJournal(env2, '42', journalCap('pro'));
		expect(premium.length).toBe(25);
	});
});

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
		const ok = await callApp('/trails/trail_sit_spot');
		expect(ok.response.status).toBe(200);
		const missing = await callApp('/trails/trail_missing');
		expect(missing.response.status).toBe(404);
	});

	it('GET /v1/trails/:id gates a premium trail for a free rank', async () => {
		const { response } = await callApp('/trails/trail_open_sky?rank=free');
		expect(response.status).toBe(403);
		const pro = await callApp('/trails/trail_open_sky?rank=pro');
		expect(pro.response.status).toBe(200);
	});

	it('POST /v1/trails/:id/start opens a run', async () => {
		const bindings = createMockBindings();
		const res = await callApp(
			'/trails/trail_sit_spot/start',
			{ method: 'POST', body: JSON.stringify({ uid: '42', pledge: { when: 'tomorrow morning' } }) },
			true,
			bindings
		);
		expect(res.response.status).toBe(201);
		const run = (await res.response.json()) as { trailId: string; completed: boolean };
		expect(run.trailId).toBe('trail_sit_spot');
		expect(run.completed).toBe(false);
	});

	it('POST /v1/trails/:id/start 404s an unknown trail and 400s a bad uid', async () => {
		const missing = await callApp('/trails/trail_nope/start', {
			method: 'POST',
			body: JSON.stringify({ uid: '42' })
		});
		expect(missing.response.status).toBe(404);
		const badUid = await callApp('/trails/trail_sit_spot/start', {
			method: 'POST',
			body: JSON.stringify({ uid: 'abc' })
		});
		expect(badUid.response.status).toBe(400);
	});

	it('POST /v1/trails/:id/start gates a premium trail for a free rank', async () => {
		const locked = await callApp('/trails/trail_open_sky/start', {
			method: 'POST',
			body: JSON.stringify({ uid: '42', rank: 'free' })
		});
		expect(locked.response.status).toBe(403);
		const pro = await callApp('/trails/trail_open_sky/start', {
			method: 'POST',
			body: JSON.stringify({ uid: '42', rank: 'pro' })
		});
		expect(pro.response.status).toBe(201);
	});

	it('POST /v1/trails/:id/complete records a journal entry the journal route returns', async () => {
		const bindings = createMockBindings();
		await callApp(
			'/trails/trail_sit_spot/start',
			{ method: 'POST', body: JSON.stringify({ uid: '42' }) },
			true,
			bindings
		);
		const done = await callApp(
			'/trails/trail_sit_spot/complete',
			{
				method: 'POST',
				body: JSON.stringify({
					uid: '42',
					presenceMinutes: 12,
					reflection: { note: 'lovely', mood: 'calm' }
				})
			},
			true,
			bindings
		);
		expect(done.response.status).toBe(200);
		const result = (await done.response.json()) as {
			entry: { trailId: string };
			natureMinutes: { minutes: number; sources: { kind: string }[] };
		};
		expect(result.entry.trailId).toBe('trail_sit_spot');
		expect(result.natureMinutes.minutes).toBe(12);
		expect(result.natureMinutes.sources[0].kind).toBe('trail');

		const journal = await callApp('/users/trail-journal?uid=42', {}, true, bindings);
		expect(journal.response.status).toBe(200);
		const entries = (await journal.response.json()) as unknown[];
		expect(entries.length).toBe(1);
	});

	it('POST /v1/trails/:id/complete rejects a missing presenceMinutes', async () => {
		const res = await callApp('/trails/trail_sit_spot/complete', {
			method: 'POST',
			body: JSON.stringify({ uid: '42', reflection: {} })
		});
		expect(res.response.status).toBe(400);
	});

	it('GET /v1/users/trail-journal requires a valid uid', async () => {
		const bad = await callApp('/users/trail-journal');
		expect(bad.response.status).toBe(400);
		const ok = await callApp('/users/trail-journal?uid=42');
		expect(ok.response.status).toBe(200);
	});

	it('GET /v1/users/trail-run returns the active run and 404s when none', async () => {
		const bindings = createMockBindings();
		await callApp(
			'/trails/trail_sit_spot/start',
			{ method: 'POST', body: JSON.stringify({ uid: '42' }) },
			true,
			bindings
		);
		const ok = await callApp('/users/trail-run?uid=42&trailId=trail_sit_spot', {}, true, bindings);
		expect(ok.response.status).toBe(200);
		const none = await callApp(
			'/users/trail-run?uid=99&trailId=trail_sit_spot',
			{},
			true,
			bindings
		);
		expect(none.response.status).toBe(404);
		const badTrail = await callApp(
			'/users/trail-run?uid=42&trailId=trail_nope',
			{},
			true,
			bindings
		);
		expect(badTrail.response.status).toBe(400);
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
			{ method: 'POST', body: JSON.stringify({ uid: '42', minutes: 25, kind: 'trail' }) },
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
