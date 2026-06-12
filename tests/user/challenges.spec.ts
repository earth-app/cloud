import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	acceptChallenge,
	createChallenge,
	declineChallenge,
	getActiveChallengeFor,
	getChallenge,
	notifyChallengeStep
} from '../../src/user/challenges';
import { createMockBindings } from '../helpers/mock-bindings';
import { Bindings, ExecutionCtxLike } from '../../src/util/types';

function collectingCtx() {
	const promises: Promise<unknown>[] = [];
	const ctx: ExecutionCtxLike = {
		waitUntil: (p: Promise<unknown>) => {
			promises.push(Promise.resolve(p).catch(() => {}));
		}
	};
	return { ctx, settle: () => Promise.all(promises) };
}

const baseInput = {
	quest_id: 'sunrise_photo',
	quest_title: 'Sunrise Photo',
	challenger_id: '100',
	challenger_name: 'greg',
	recipient_id: '200',
	recipient_name: 'alex'
};

describe('challenges', () => {
	let env: Bindings;
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		env = createMockBindings();
		fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('creates a pending challenge and dedupes the same pairing', async () => {
		const a = await createChallenge(env, baseInput);
		expect(a.status).toBe('pending');
		const b = await createChallenge(env, baseInput);
		expect(b.id).toBe(a.id); // reused, not a new record
	});

	it('only the recipient can accept, flipping it active for both sides', async () => {
		const challenge = await createChallenge(env, baseInput);

		const wrong = await acceptChallenge(env, challenge.id, '100', collectingCtx().ctx);
		expect(wrong).toMatchObject({ ok: false, reason: 'forbidden' });

		const { ctx, settle } = collectingCtx();
		const ok = await acceptChallenge(env, challenge.id, '200', ctx);
		expect(ok).toMatchObject({ ok: true });
		expect(ok.challenge?.status).toBe('active');
		await settle();

		// active for both participants on this quest
		expect(await getActiveChallengeFor(env, '100', 'sunrise_photo')).not.toBeNull();
		expect(await getActiveChallengeFor(env, '200', 'sunrise_photo')).not.toBeNull();

		// accepting again is a bad status transition
		const again = await acceptChallenge(env, challenge.id, '200', collectingCtx().ctx);
		expect(again).toMatchObject({ ok: false, reason: 'bad_status' });
	});

	it('declining marks it declined and frees the pairing', async () => {
		const challenge = await createChallenge(env, baseInput);
		const { ctx, settle } = collectingCtx();
		const res = await declineChallenge(env, challenge.id, '200', ctx);
		expect(res).toMatchObject({ ok: true });
		await settle();
		expect((await getChallenge(env, challenge.id))?.status).toBe('declined');
		// pairing freed → a new create makes a fresh record
		const fresh = await createChallenge(env, baseInput);
		expect(fresh.id).not.toBe(challenge.id);
	});

	it('notifies the other participant on a step, and completes on the final step', async () => {
		const challenge = await createChallenge(env, baseInput);
		const accept = collectingCtx();
		await acceptChallenge(env, challenge.id, '200', accept.ctx);
		await accept.settle();
		fetchSpy.mockClear();

		// greg (challenger) completes a step → alex (recipient) is notified
		const step = collectingCtx();
		await notifyChallengeStep(env, '100', 'sunrise_photo', 1, false, step.ctx);
		await step.settle();
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [url] = fetchSpy.mock.calls[0];
		expect(String(url)).toContain('/v2/users/200/notifications');

		// final step → challenge marked completed
		const done = collectingCtx();
		await notifyChallengeStep(env, '100', 'sunrise_photo', 4, true, done.ctx);
		await done.settle();
		expect((await getChallenge(env, challenge.id))?.status).toBe('completed');
	});

	it('returns null active challenge when there is none', async () => {
		expect(await getActiveChallengeFor(env, '999', 'sunrise_photo')).toBeNull();
	});
});
