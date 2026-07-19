import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	startExpedition,
	getExpedition,
	getExpeditionByOwner,
	creditContribution,
	computeGarden,
	expeditionMinutes,
	isExpeditionGoal
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

	it('garden renders a calm baseline for a circle with no expedition', async () => {
		const { response } = await callApp('/circles/100/garden');
		expect(response.status).toBe(200);
		const g = (await response.json()) as { animated: boolean; level: number };
		expect(g.animated).toBe(false);
		expect(g.level).toBe(0);
	});
});
