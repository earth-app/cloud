import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	startExpedition,
	getExpedition,
	getExpeditionByOwner,
	creditContribution,
	computeGarden,
	expeditionMinutes,
	getExpeditionsForActivity,
	isExpeditionGoal,
	MAX_ACTIVITY_EXPEDITIONS
} from '../../src/user/expeditions';
import { isBadgeGranted } from '../../src/user/badges';
import { createMockBindings } from '../helpers/mock-bindings';
import { callApp } from '../helpers/call-app';
import type { Bindings } from '../../src/util/types';

const future = () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

// badge grants notify mantle over fetch; keep every direct-call test off the network
beforeEach(() => {
	vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
});
afterEach(() => vi.restoreAllMocks());

describe('isExpeditionGoal', () => {
	it('accepts the three shared goals and rejects anything else', () => {
		expect(isExpeditionGoal('nature_minutes')).toBe(true);
		expect(isExpeditionGoal('trails')).toBe(true);
		expect(isExpeditionGoal('quests')).toBe(true);
		// the legacy step-based goal is gone
		expect(isExpeditionGoal('trail_steps')).toBe(false);
		expect(isExpeditionGoal('followers')).toBe(false);
		expect(isExpeditionGoal(42)).toBe(false);
	});
});

describe('startExpedition', () => {
	let env: Bindings;
	beforeEach(() => (env = createMockBindings()));

	it('creates an expedition with the owner seeded as a contributor', async () => {
		const exp = await startExpedition(env, {
			owner_uid: '100',
			title: 'Weekend Wander',
			goal: 'nature_minutes',
			target: 300,
			ends_at: future(),
			members: [{ uid: '200', username: 'alex' }]
		});
		expect(exp.owner_uid).toBe('100');
		expect(exp.target).toBe(300);
		expect(exp.progress).toBe(0);
		expect(exp.status).toBe('active');
		expect(exp.contributors.some((c) => c.uid === '100')).toBe(true);
		expect(exp.contributors.some((c) => c.uid === '200')).toBe(true);
	});

	it('clamps a non-positive target and repairs an invalid ends_at', async () => {
		const exp = await startExpedition(env, {
			owner_uid: '1',
			title: '',
			goal: 'quests',
			target: -5,
			ends_at: 'not-a-date'
		});
		expect(exp.target).toBeGreaterThanOrEqual(1);
		expect(Date.parse(exp.ends_at)).toBeGreaterThan(Date.now());
	});

	it('is readable by id and by owner with a computed status', async () => {
		const exp = await startExpedition(env, {
			owner_uid: '100',
			title: 'x',
			goal: 'nature_minutes',
			target: 100,
			ends_at: future()
		});
		expect((await getExpedition(env, exp.id))?.id).toBe(exp.id);
		expect((await getExpeditionByOwner(env, '100'))?.id).toBe(exp.id);
		expect(await getExpeditionByOwner(env, '999')).toBeNull();
	});
});

describe('creditContribution', () => {
	let env: Bindings;
	beforeEach(() => (env = createMockBindings()));

	async function seed(target: number) {
		return startExpedition(env, {
			owner_uid: '100',
			title: 'goal',
			goal: 'nature_minutes',
			target,
			ends_at: future(),
			members: [{ uid: '200', username: 'alex' }]
		});
	}

	it('credits a member and advances the shared progress', async () => {
		await seed(100);
		const res = await creditContribution(env, '100', '200', 40, 'alex');
		expect(res.ok).toBe(true);
		if (res.ok) {
			expect(res.expedition.progress).toBe(40);
			const alex = res.expedition.contributors.find((c) => c.uid === '200');
			expect(alex?.contribution).toBe(40);
			expect(res.justCompleted).toBe(false);
		}
	});

	it('flips justCompleted exactly once and then reports closed', async () => {
		await seed(50);
		const first = await creditContribution(env, '100', '200', 50);
		expect(first.ok && first.justCompleted).toBe(true);
		// expedition is now complete; a further credit is refused
		const again = await creditContribution(env, '100', '200', 10);
		expect(again).toMatchObject({ ok: false, reason: 'closed' });
	});

	it('returns not_found when the circle has no expedition', async () => {
		const res = await creditContribution(env, '100', '200', 5);
		expect(res).toMatchObject({ ok: false, reason: 'not_found' });
	});

	it('adds a new member to the roster on first contribution', async () => {
		await seed(100);
		const res = await creditContribution(env, '100', '300', 10, 'sam');
		expect(res.ok).toBe(true);
		if (res.ok) {
			expect(res.expedition.contributors.some((c) => c.uid === '300')).toBe(true);
		}
	});

	it('still advances the shared total when the roster is full (no new contributor added)', async () => {
		// seed past the 24-contributor cap; the roster fills, the shared goal keeps moving
		const members = Array.from({ length: 30 }, (_, i) => ({
			uid: String(i + 1),
			username: `m${i + 1}`
		}));
		await startExpedition(env, {
			owner_uid: '100',
			title: 'Full Circle',
			goal: 'nature_minutes',
			target: 100000,
			ends_at: future(),
			members
		});
		const before = await getExpeditionByOwner(env, '100');
		expect(before?.contributors.length).toBe(24);

		const res = await creditContribution(env, '100', '99999', 40, 'newcomer');
		expect(res.ok).toBe(true);
		if (res.ok) {
			// the shared total moved even though the roster could not grow
			expect(res.expedition.progress).toBe(40);
			expect(res.expedition.contributors.length).toBe(24);
			expect(res.expedition.contributors.some((c) => c.uid === '99999')).toBe(false);
		}
	});

	it('clamps a negative credit to zero and leaves progress unchanged', async () => {
		await seed(100);
		const res = await creditContribution(env, '100', '200', -50, 'alex');
		expect(res.ok).toBe(true);
		if (res.ok) {
			expect(res.expedition.progress).toBe(0);
		}
	});
});

describe('expired status', () => {
	it('recomputes an expired status from a past ends_at', async () => {
		const env = createMockBindings();
		const id = 'deadbeefcafe';
		const past = new Date(Date.now() - 60_000).toISOString();
		await env.KV.put(
			`expedition:${id}`,
			JSON.stringify({
				id,
				owner_uid: '100',
				title: 'old',
				goal: 'nature_minutes',
				target: 100,
				progress: 10,
				contributors: [],
				status: 'active',
				starts_at: past,
				ends_at: past
			})
		);
		const exp = await getExpedition(env, id);
		expect(exp?.status).toBe('expired');
	});
});

describe('computeGarden', () => {
	it('projects contribution onto deterministic, stable element seeds', () => {
		const exp = {
			id: 'a',
			owner_uid: '100',
			title: 't',
			goal: 'nature_minutes' as const,
			target: 240,
			progress: 240,
			contributors: [{ uid: '200', username: 'alex', contribution: 240 }],
			status: 'active' as const,
			starts_at: new Date().toISOString(),
			ends_at: future()
		};
		const g1 = computeGarden('100', exp);
		const g2 = computeGarden('100', exp);
		expect(g1.elements.map((e) => e.seed)).toEqual(g2.elements.map((e) => e.seed));
		expect(g1.level).toBeGreaterThanOrEqual(1);
		expect(g1.total_minutes).toBe(240);
		// a different owner grows a different garden
		const gOther = computeGarden('101', exp);
		expect(gOther.elements[0].seed).not.toBe(g1.elements[0].seed);
	});

	it('reseeds when the owner activity fingerprint changes, and only then', () => {
		const before = computeGarden('100', null);
		const unchanged = computeGarden('100', null, { activityFingerprint: '' });
		const reseeded = computeGarden('100', null, { activityFingerprint: 'abc123' });
		const again = computeGarden('100', null, { activityFingerprint: 'abc123' });
		const other = computeGarden('100', null, { activityFingerprint: 'zzz999' });

		// an empty fingerprint must not disturb a garden that existed before activities mattered
		expect(unchanged.elements.map((e) => e.seed)).toEqual(before.elements.map((e) => e.seed));
		expect(reseeded.elements.map((e) => e.seed)).not.toEqual(before.elements.map((e) => e.seed));
		expect(again.elements.map((e) => e.seed)).toEqual(reseeded.elements.map((e) => e.seed));
		expect(other.elements.map((e) => e.seed)).not.toEqual(reseeded.elements.map((e) => e.seed));

		// the scene keeps its size and shape; only the arrangement moves
		expect(reseeded.elements).toHaveLength(before.elements.length);
		expect(reseeded.level).toBe(before.level);
	});

	it('reseeds contributor signature elements too', () => {
		const exp = {
			id: 'a',
			owner_uid: '100',
			title: 't',
			goal: 'nature_minutes' as const,
			target: 240,
			progress: 240,
			contributors: [{ uid: '200', username: 'alex', contribution: 240 }],
			status: 'active' as const,
			starts_at: new Date().toISOString(),
			ends_at: future()
		};

		const plain = computeGarden('100', exp);
		const reseeded = computeGarden('100', exp, { activityFingerprint: 'abc123' });
		const signature = (g: typeof plain) => g.elements.at(-1)!.seed;

		expect(signature(reseeded)).not.toBe(signature(plain));
	});

	it('grows a calm baseline garden with no expedition', () => {
		const g = computeGarden('100', null);
		expect(g.total_minutes).toBe(0);
		expect(g.level).toBe(0);
		expect(g.elements.length).toBeGreaterThan(0);
		expect(g.animated).toBe(false);
	});

	it('weights non-minute goals into minute-equivalents', () => {
		const exp = {
			id: 'a',
			owner_uid: '1',
			title: 't',
			goal: 'quests' as const,
			target: 10,
			progress: 4,
			contributors: [],
			status: 'active' as const,
			starts_at: new Date().toISOString(),
			ends_at: future()
		};
		// quests weight is 30 minutes-equivalent each
		expect(expeditionMinutes(exp)).toBe(120);
	});

	it('weights a completed trail into minute-equivalents', () => {
		const exp = {
			id: 'a',
			owner_uid: '1',
			title: 't',
			goal: 'trails' as const,
			target: 20,
			progress: 5,
			contributors: [],
			status: 'active' as const,
			starts_at: new Date().toISOString(),
			ends_at: future()
		};
		// a completed trail is worth 12 minutes-equivalent
		expect(expeditionMinutes(exp)).toBe(60);
	});
});

describe('expedition + garden badges', () => {
	let env: Bindings;
	beforeEach(() => (env = createMockBindings()));

	async function seed(target: number) {
		return startExpedition(env, {
			owner_uid: '100',
			title: 'goal',
			goal: 'nature_minutes',
			target,
			ends_at: future(),
			members: [{ uid: '200', username: 'alex' }]
		});
	}

	it('a contribution unlocks first_contribution for the member', async () => {
		await seed(500);
		await creditContribution(env, '100', '200', 30, 'alex');
		expect(await isBadgeGranted('200', 'first_contribution', env.KV)).toBe(true);
	});

	it('growing the shared garden to level 5 unlocks garden_bloom for the owner', async () => {
		await seed(700);
		await creditContribution(env, '100', '200', 600, 'alex');
		expect(await isBadgeGranted('100', 'garden_bloom', env.KV)).toBe(true);
		expect(await isBadgeGranted('100', 'garden_grove', env.KV)).toBe(false);
	});

	it('growing the shared garden to level 10 unlocks the green garden_grove', async () => {
		await seed(1300);
		await creditContribution(env, '100', '200', 1200, 'alex');
		expect(await isBadgeGranted('100', 'garden_grove', env.KV)).toBe(true);
	});

	it('completing an expedition unlocks first_expedition for owner and finisher', async () => {
		await seed(100);
		const res = await creditContribution(env, '100', '200', 100);
		expect(res.ok && res.justCompleted).toBe(true);
		expect(await isBadgeGranted('100', 'first_expedition', env.KV)).toBe(true);
		expect(await isBadgeGranted('200', 'first_expedition', env.KV)).toBe(true);
	});
});

describe('circle expedition + garden routes', () => {
	afterEach(() => vi.restoreAllMocks());

	it('starts, reads, contributes, and projects a garden over one circle', async () => {
		const bindings = createMockBindings();

		const start = await callApp(
			'/circles/100/expedition',
			{
				method: 'POST',
				body: JSON.stringify({
					title: 'Team Trek',
					goal: 'nature_minutes',
					target: 200,
					ends_at: future(),
					members: [{ uid: '200', username: 'alex' }]
				})
			},
			true,
			bindings
		);
		expect(start.response.status).toBe(201);
		const exp = (await start.response.json()) as { id: string };

		const get = await callApp('/circles/100/expedition', {}, true, bindings);
		expect(get.response.status).toBe(200);

		const byId = await callApp(`/expeditions/${exp.id}`, {}, true, bindings);
		expect(byId.response.status).toBe(200);

		const contribute = await callApp(
			'/circles/100/expedition/contribute',
			{ method: 'POST', body: JSON.stringify({ member_uid: '200', amount: 60 }) },
			true,
			bindings
		);
		expect(contribute.response.status).toBe(200);
		const cbody = (await contribute.response.json()) as { expedition: { progress: number } };
		expect(cbody.expedition.progress).toBe(60);

		const garden = await callApp('/circles/100/garden?rank=pro', {}, true, bindings);
		expect(garden.response.status).toBe(200);
		const gbody = (await garden.response.json()) as { animated: boolean; total_minutes: number };
		expect(gbody.animated).toBe(true);
		expect(gbody.total_minutes).toBe(60);
	});

	it('rejects an invalid goal and a missing expedition', async () => {
		const badGoal = await callApp('/circles/100/expedition', {
			method: 'POST',
			body: JSON.stringify({ goal: 'nope', target: 10, ends_at: future() })
		});
		expect(badGoal.response.status).toBe(400);

		const noExp = await callApp('/circles/999/expedition');
		expect(noExp.response.status).toBe(404);
	});

	it('contribute returns 404 when the circle has no expedition', async () => {
		const { response } = await callApp('/circles/555/expedition/contribute', {
			method: 'POST',
			body: JSON.stringify({ member_uid: '200', amount: 5 })
		});
		expect(response.status).toBe(404);
	});

	it('contribute rejects a non-positive amount and a missing member_uid', async () => {
		const bindings = createMockBindings();
		await callApp(
			'/circles/100/expedition',
			{
				method: 'POST',
				body: JSON.stringify({ goal: 'nature_minutes', target: 100, ends_at: future() })
			},
			true,
			bindings
		);

		const zero = await callApp(
			'/circles/100/expedition/contribute',
			{ method: 'POST', body: JSON.stringify({ member_uid: '200', amount: 0 }) },
			true,
			bindings
		);
		expect(zero.response.status).toBe(400);

		const noMember = await callApp(
			'/circles/100/expedition/contribute',
			{ method: 'POST', body: JSON.stringify({ amount: 10 }) },
			true,
			bindings
		);
		expect(noMember.response.status).toBe(400);
	});

	it('contribute to a completed expedition returns 409 (idempotent double-complete)', async () => {
		const bindings = createMockBindings();
		await callApp(
			'/circles/100/expedition',
			{
				method: 'POST',
				body: JSON.stringify({ goal: 'nature_minutes', target: 50, ends_at: future() })
			},
			true,
			bindings
		);

		const finish = await callApp(
			'/circles/100/expedition/contribute',
			{ method: 'POST', body: JSON.stringify({ member_uid: '200', amount: 50 }) },
			true,
			bindings
		);
		expect(finish.response.status).toBe(200);
		const fbody = (await finish.response.json()) as { just_completed: boolean };
		expect(fbody.just_completed).toBe(true);

		const again = await callApp(
			'/circles/100/expedition/contribute',
			{ method: 'POST', body: JSON.stringify({ member_uid: '200', amount: 10 }) },
			true,
			bindings
		);
		expect(again.response.status).toBe(409);
	});

	it('garden renders a calm baseline for a circle with no expedition', async () => {
		const { response } = await callApp('/circles/100/garden');
		expect(response.status).toBe(200);
		const g = (await response.json()) as { animated: boolean; level: number };
		expect(g.animated).toBe(false);
		expect(g.level).toBe(0);
	});
});

describe('activity-gathered expeditions', () => {
	function future(days = 7): string {
		return new Date(Date.now() + days * 86400000).toISOString();
	}

	async function start(env: Bindings, owner: string, activityId?: string, title = 'Group Walk') {
		return startExpedition(env, {
			owner_uid: owner,
			title,
			goal: 'nature_minutes',
			target: 240,
			ends_at: future(),
			...(activityId ? { activity_id: activityId } : {})
		});
	}

	it('sanitizes the activity id onto the expedition', async () => {
		const env = createMockBindings();
		const exp = await start(env, '100', ' Bouldering!! ');
		expect(exp.activity_id).toBe('bouldering');

		const bare = await start(env, '101', '???');
		expect(bare.activity_id).toBeUndefined();
	});

	it('finds open expeditions by the activity they are gathered around', async () => {
		const env = createMockBindings();
		const bouldering = await start(env, '100', 'bouldering', 'Chalk Club');
		await start(env, '101', 'birdwatching', 'Dawn Chorus');
		await start(env, '102', undefined, 'Unthemed');

		const found = await getExpeditionsForActivity(env, 'Bouldering');
		expect(found.map((e) => e.id)).toEqual([bouldering.id]);
		expect(found[0]!.title).toBe('Chalk Club');

		expect(await getExpeditionsForActivity(env, 'kayaking')).toEqual([]);
		expect(await getExpeditionsForActivity(env, '!!!')).toEqual([]);
	});

	it('lists several expeditions for one activity, newest first, capped', async () => {
		const env = createMockBindings();
		for (let i = 0; i < 4; i++) await start(env, `${200 + i}`, 'bouldering', `Group ${i}`);

		const all = await getExpeditionsForActivity(env, 'bouldering');
		expect(all).toHaveLength(4);

		const capped = await getExpeditionsForActivity(env, 'bouldering', 2);
		expect(capped).toHaveLength(2);
		expect(capped.length).toBeLessThanOrEqual(MAX_ACTIVITY_EXPEDITIONS);
	});

	it('never offers a finished expedition as something to join', async () => {
		const env = createMockBindings();
		const exp = await start(env, '100', 'bouldering');

		// expire it the way the reader sees it: past ends_at
		const stored = JSON.parse((await env.KV.get(`expedition:${exp.id}`))!) as Record<
			string,
			unknown
		>;
		stored.ends_at = new Date(Date.now() - 86400000).toISOString();
		await env.KV.put(`expedition:${exp.id}`, JSON.stringify(stored));

		expect(await getExpeditionsForActivity(env, 'bouldering')).toEqual([]);
	});

	it('serves the join surface over the route', async () => {
		const bindings = createMockBindings();
		await start(bindings, '100', 'bouldering', 'Chalk Club');

		const res = await callApp('/activities/bouldering/expeditions', {}, true, bindings);
		expect(res.response.status).toBe(200);
		expect(await res.response.json()).toMatchObject({
			total: 1,
			expeditions: [{ title: 'Chalk Club', activity_id: 'bouldering' }]
		});

		const bad = await callApp(`/activities/${'x'.repeat(80)}/expeditions`, {}, true, bindings);
		expect(bad.response.status).toBe(400);
	});
});
