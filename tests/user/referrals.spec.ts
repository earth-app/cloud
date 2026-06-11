import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createOrGetCode,
	getByCode,
	getStats,
	recordClick,
	recordConversion
} from '../../src/user/referrals';
import { getImpactPoints } from '../../src/user/points';
import { isBadgeGranted } from '../../src/user/badges';
import { createMockBindings } from '../helpers/mock-bindings';
import { Bindings, ExecutionCtxLike } from '../../src/util/types';

// collects waitUntil work so tests can await badge grants / notifications
function collectingCtx() {
	const promises: Promise<unknown>[] = [];
	const ctx: ExecutionCtxLike = {
		waitUntil: (p: Promise<unknown>) => {
			promises.push(Promise.resolve(p).catch(() => {}));
		}
	};
	return { ctx, settle: () => Promise.all(promises) };
}

describe('referrals', () => {
	let env: Bindings;

	beforeEach(() => {
		env = createMockBindings();
		// keep notification fetches off the network
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('createOrGetCode is idempotent and yields a valid code', async () => {
		const a = await createOrGetCode(env, '0007');
		const b = await createOrGetCode(env, '7');
		expect(a).toBe(b);
		expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);
	});

	it('records clicks on the code', async () => {
		const code = await createOrGetCode(env, '10');
		await recordClick(env, code);
		await recordClick(env, code);
		const record = await getByCode(env, code);
		expect(record?.clicks).toBe(2);
	});

	it('rejects self-referral and invalid codes', async () => {
		const code = await createOrGetCode(env, '20');
		expect(await recordConversion(env, code, '20', collectingCtx().ctx)).toMatchObject({
			ok: false,
			reason: 'self_referral'
		});
		expect(await recordConversion(env, 'ZZZZZZ', '21', collectingCtx().ctx)).toMatchObject({
			ok: false,
			reason: 'invalid_code'
		});
	});

	it('awards both parties once and blocks double attribution', async () => {
		const code = await createOrGetCode(env, '100');
		const { ctx, settle } = collectingCtx();

		const first = await recordConversion(env, code, '200', ctx);
		expect(first).toMatchObject({ ok: true, referrer_id: '100' });

		const second = await recordConversion(env, code, '200', ctx);
		expect(second).toMatchObject({ ok: false, reason: 'already_attributed' });

		await settle();

		const [referrerPoints] = await getImpactPoints('100', env.KV);
		const [refereePoints] = await getImpactPoints('200', env.KV);
		expect(referrerPoints).toBeGreaterThanOrEqual(50); // 50 referral + recruiter badge bonus
		expect(refereePoints).toBe(25);

		const stats = await getStats(env, '100');
		expect(stats.conversions).toBe(1);
		expect(stats.converted_ids).toEqual(['200']);
	});

	it('grants recruiter tiers as conversions cross thresholds', async () => {
		const code = await createOrGetCode(env, '500');

		const { ctx, settle } = collectingCtx();
		await recordConversion(env, code, '1', ctx);
		await settle();
		expect(await isBadgeGranted('500', 'recruiter', env.KV)).toBe(true);
		expect(await isBadgeGranted('500', 'super_recruiter', env.KV)).toBe(false);

		const { ctx: ctx2, settle: settle2 } = collectingCtx();
		for (let i = 2; i <= 5; i++) {
			await recordConversion(env, code, String(i), ctx2);
		}
		await settle2();
		expect(await isBadgeGranted('500', 'super_recruiter', env.KV)).toBe(true);
		expect(await isBadgeGranted('500', 'master_recruiter', env.KV)).toBe(false);
	});
});
