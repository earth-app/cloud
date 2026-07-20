import { Bindings } from '../util/types';
import { normalizeId } from '../util/util';

export type OnboardingStepId =
	| 'welcome'
	| 'pick_interests'
	| 'first_activity'
	| 'first_prompt_response'
	| 'first_article_read'
	| 'first_quest_started'
	| 'first_quest_completed'
	| 'first_friend'
	| 'verify_email'
	| 'first_trail'
	| 'first_trailmark'
	| 'grow_shared_garden'
	| 'complete';

export const ONBOARDING_STEPS: OnboardingStepId[] = [
	'welcome',
	'pick_interests',
	'first_activity',
	'first_quest_started',
	'first_prompt_response',
	'first_article_read',
	'first_quest_completed',
	'first_friend',
	'verify_email',
	'first_trail',
	'first_trailmark',
	'grow_shared_garden',
	'complete'
];

export type OnboardingState = {
	user_id: string;
	completed_steps: OnboardingStepId[];
	persona?: string;
	interests: string[];
	started_at: number;
	finished_at: number | null;
	dismissed_at: number | null;
	updated_at: number;
};

const KEY = (userId: string) => `user:onboarding:${normalizeId(userId)}`;

// keep onboarding state long enough that returning users can still see their checklist
const TTL_SECONDS = 60 * 60 * 24 * 365; // 1 year

function emptyState(userId: string): OnboardingState {
	const now = Date.now();
	return {
		user_id: normalizeId(userId),
		completed_steps: [],
		persona: undefined,
		interests: [],
		started_at: now,
		finished_at: null,
		dismissed_at: null,
		updated_at: now
	};
}

export async function getOnboarding(
	env: Bindings,
	userId: string
): Promise<OnboardingState | null> {
	const raw = await env.KV.get(KEY(userId));
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as OnboardingState;
		// defensive: never let bad cached shapes propagate as crashes upstream
		if (!parsed || typeof parsed !== 'object') return null;
		if (!Array.isArray(parsed.completed_steps)) parsed.completed_steps = [];
		if (!Array.isArray(parsed.interests)) parsed.interests = [];

		return parsed;
	} catch {
		return null;
	}
}

export async function getOrCreateOnboarding(
	env: Bindings,
	userId: string
): Promise<OnboardingState> {
	const existing = await getOnboarding(env, userId);
	if (existing) return existing;
	const fresh = emptyState(userId);
	await putOnboarding(env, fresh);
	return fresh;
}

async function putOnboarding(env: Bindings, state: OnboardingState): Promise<void> {
	state.updated_at = Date.now();
	await env.KV.put(KEY(state.user_id), JSON.stringify(state), {
		expirationTtl: TTL_SECONDS
	});
}

export async function completeStep(
	env: Bindings,
	userId: string,
	step: OnboardingStepId
): Promise<OnboardingState> {
	const state = await getOrCreateOnboarding(env, userId);
	if (!state.completed_steps.includes(step)) {
		state.completed_steps.push(step);
	}
	if (
		step === 'complete' ||
		ONBOARDING_STEPS.every((s) => state.completed_steps.includes(s) || s === 'complete')
	) {
		if (!state.finished_at) state.finished_at = Date.now();
	}
	await putOnboarding(env, state);
	return state;
}

export async function setPersona(
	env: Bindings,
	userId: string,
	persona: string,
	interests: string[]
): Promise<OnboardingState> {
	const state = await getOrCreateOnboarding(env, userId);
	state.persona = persona;
	state.interests = interests.slice(0, 20);
	if (!state.completed_steps.includes('pick_interests')) {
		state.completed_steps.push('pick_interests');
	}
	await putOnboarding(env, state);
	return state;
}

export async function dismissOnboarding(env: Bindings, userId: string): Promise<OnboardingState> {
	const state = await getOrCreateOnboarding(env, userId);
	state.dismissed_at = Date.now();
	await putOnboarding(env, state);
	return state;
}

export async function resetOnboarding(env: Bindings, userId: string): Promise<void> {
	await env.KV.delete(KEY(userId));
}
