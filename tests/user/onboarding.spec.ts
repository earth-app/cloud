import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	ONBOARDING_STEPS,
	getOnboarding,
	getOrCreateOnboarding,
	completeStep,
	setPersona,
	dismissOnboarding,
	resetOnboarding
} from '../../src/user/onboarding';
import type { OnboardingState } from '../../src/user/onboarding';
import { createMockBindings } from '../helpers/mock-bindings';
import { callApp } from '../helpers/call-app';
import type { Bindings } from '../../src/util/types';

// key format lives inside the module; mirror it so malformed-cache tests can seed raw values
const key = (uid: string) => `user:onboarding:${uid}`;

describe('onboarding steps catalog', () => {
	it('includes the three v0.6.0 outdoor steps in the canonical order', () => {
		expect(ONBOARDING_STEPS).toContain('first_trail');
		expect(ONBOARDING_STEPS).toContain('first_trailmark');
		expect(ONBOARDING_STEPS).toContain('grow_shared_garden');
		// complete is always the terminal step
		expect(ONBOARDING_STEPS[ONBOARDING_STEPS.length - 1]).toBe('complete');
		// the new steps come after email verification, before complete
		const verify = ONBOARDING_STEPS.indexOf('verify_email');
		expect(ONBOARDING_STEPS.indexOf('first_trail')).toBeGreaterThan(verify);
		expect(ONBOARDING_STEPS.indexOf('grow_shared_garden')).toBeLessThan(
			ONBOARDING_STEPS.indexOf('complete')
		);
	});
});

describe('onboarding state module', () => {
	let env: Bindings;
	beforeEach(() => (env = createMockBindings()));

	it('returns null before any state exists', async () => {
		expect(await getOnboarding(env, '42')).toBeNull();
	});

	it('getOrCreateOnboarding seeds and persists an empty state', async () => {
		const state = await getOrCreateOnboarding(env, '42');
		expect(state.user_id).toBe('42');
		expect(state.completed_steps).toEqual([]);
		expect(state.interests).toEqual([]);
		expect(state.finished_at).toBeNull();
		expect(state.dismissed_at).toBeNull();
		// it was written, so a follow-up read finds it
		expect((await getOnboarding(env, '42'))?.user_id).toBe('42');
	});

	it('normalizes a padded uid to the same state key', async () => {
		await getOrCreateOnboarding(env, '0042');
		expect((await getOnboarding(env, '42'))?.user_id).toBe('42');
	});

	it('completeStep records a step and de-duplicates a repeat', async () => {
		await completeStep(env, '42', 'first_trail');
		const state = await completeStep(env, '42', 'first_trail');
		expect(state.completed_steps.filter((s) => s === 'first_trail')).toHaveLength(1);
	});

	it('marks finished_at when the terminal step is completed', async () => {
		const state = await completeStep(env, '7', 'complete');
		expect(state.finished_at).not.toBeNull();
	});

	it('marks finished_at once every non-terminal step is done', async () => {
		let state: OnboardingState | undefined;
		for (const step of ONBOARDING_STEPS) {
			if (step === 'complete') continue;
			state = await completeStep(env, '9', step);
		}
		expect(state?.finished_at).not.toBeNull();
	});

	it('setPersona stores the persona, caps interests at 20, and marks pick_interests', async () => {
		const interests = Array.from({ length: 30 }, (_, i) => `interest_${i}`);
		const state = await setPersona(env, '42', 'explorer', interests);
		expect(state.persona).toBe('explorer');
		expect(state.interests).toHaveLength(20);
		expect(state.completed_steps).toContain('pick_interests');
	});

	it('dismissOnboarding stamps dismissed_at without finishing', async () => {
		const state = await dismissOnboarding(env, '42');
		expect(state.dismissed_at).not.toBeNull();
		expect(state.finished_at).toBeNull();
	});

	it('resetOnboarding removes the state entirely', async () => {
		await getOrCreateOnboarding(env, '42');
		await resetOnboarding(env, '42');
		expect(await getOnboarding(env, '42')).toBeNull();
	});

	it('returns null for a malformed cached JSON blob rather than throwing', async () => {
		await env.KV.put(key('42'), 'not-json{');
		expect(await getOnboarding(env, '42')).toBeNull();
	});

	it('coerces non-array completed_steps / interests from a poisoned cache', async () => {
		await env.KV.put(
			key('42'),
			JSON.stringify({
				user_id: '42',
				completed_steps: 'oops',
				interests: null,
				started_at: 1,
				finished_at: null,
				dismissed_at: null,
				updated_at: 1
			})
		);
		const state = await getOnboarding(env, '42');
		expect(state?.completed_steps).toEqual([]);
		expect(state?.interests).toEqual([]);
	});
});

describe('onboarding routes', () => {
	beforeEach(() => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
	});
	afterEach(() => vi.restoreAllMocks());

	it('rejects unauthenticated requests', async () => {
		const { response } = await callApp('/users/onboarding/42', {}, false);
		expect(response.status).toBe(401);
	});

	it('GET returns the state and the full step list', async () => {
		const { response } = await callApp('/users/onboarding/42');
		expect(response.status).toBe(200);
		const body = (await response.json()) as { state: OnboardingState; steps: string[] };
		expect(body.state.user_id).toBe('42');
		expect(body.steps).toContain('grow_shared_garden');
	});

	it('POST /step advances a valid step and rejects an unknown one', async () => {
		const bindings = createMockBindings();
		const ok = await callApp(
			'/users/onboarding/42/step',
			{ method: 'POST', body: JSON.stringify({ step: 'first_trailmark' }) },
			true,
			bindings
		);
		expect(ok.response.status).toBe(200);
		const body = (await ok.response.json()) as { state: OnboardingState };
		expect(body.state.completed_steps).toContain('first_trailmark');

		const bad = await callApp('/users/onboarding/42/step', {
			method: 'POST',
			body: JSON.stringify({ step: 'not_a_real_step' })
		});
		expect(bad.response.status).toBe(400);
	});

	it('POST /step rejects malformed JSON and a missing step', async () => {
		const badJson = await callApp('/users/onboarding/42/step', {
			method: 'POST',
			body: 'not-json'
		});
		expect(badJson.response.status).toBe(400);

		const missing = await callApp('/users/onboarding/42/step', {
			method: 'POST',
			body: JSON.stringify({})
		});
		expect(missing.response.status).toBe(400);
	});

	it('POST /persona validates the persona and stores interests', async () => {
		const bindings = createMockBindings();
		const ok = await callApp(
			'/users/onboarding/42/persona',
			{ method: 'POST', body: JSON.stringify({ persona: 'explorer', interests: ['hiking'] }) },
			true,
			bindings
		);
		expect(ok.response.status).toBe(200);
		const body = (await ok.response.json()) as { state: OnboardingState };
		expect(body.state.persona).toBe('explorer');
		expect(body.state.interests).toContain('hiking');

		const empty = await callApp('/users/onboarding/42/persona', {
			method: 'POST',
			body: JSON.stringify({ persona: '' })
		});
		expect(empty.response.status).toBe(400);

		const tooLong = await callApp('/users/onboarding/42/persona', {
			method: 'POST',
			body: JSON.stringify({ persona: 'x'.repeat(65) })
		});
		expect(tooLong.response.status).toBe(400);
	});

	it('POST /dismiss and DELETE clear the checklist', async () => {
		const bindings = createMockBindings();
		const dismiss = await callApp(
			'/users/onboarding/42/dismiss',
			{ method: 'POST' },
			true,
			bindings
		);
		expect(dismiss.response.status).toBe(200);
		const body = (await dismiss.response.json()) as { state: OnboardingState };
		expect(body.state.dismissed_at).not.toBeNull();

		const del = await callApp('/users/onboarding/42', { method: 'DELETE' }, true, bindings);
		expect(del.response.status).toBe(204);
	});
});
