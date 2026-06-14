import { beforeEach, describe, expect, it } from 'vitest';
import { createMockBindings } from '../../helpers/mock-bindings';
import { getStrikes, addStrike, resetStrikes } from '../../../src/content/moderation/strikes';
import { Bindings } from '../../../src/util/types';

let env: Bindings;

const entry = {
	content_type: 'prompt' as const,
	content_id: 'c-1',
	reason: 'spam' as const,
	source: 'user' as const
};

async function strike(userId: string) {
	return addStrike(env, userId, entry);
}

beforeEach(() => {
	env = createMockBindings();
});

describe('getStrikes', () => {
	it('returns a zeroed record for an unknown user', async () => {
		const strikes = await getStrikes(env, 'u1');
		expect(strikes.count).toBe(0);
		expect(strikes.cycles).toBe(0);
		expect(strikes.history).toEqual([]);
		expect(strikes.banned).toBe(false);
	});

	it('backfills missing fields on a partially stored record', async () => {
		await env.KV.put('user:strikes:u1', JSON.stringify({ count: 2 }));
		const strikes = await getStrikes(env, 'u1');
		expect(strikes.count).toBe(2);
		expect(strikes.cycles).toBe(0);
		expect(Array.isArray(strikes.history)).toBe(true);
		expect(strikes.banned).toBe(false);
	});
});

describe('addStrike', () => {
	it('increments the count and records history without action below threshold', async () => {
		const { strikes, action } = await strike('u1');
		expect(action).toBe('none');
		expect(strikes.count).toBe(1);
		expect(strikes.history).toHaveLength(1);
		expect(strikes.history[0]).toMatchObject({ content_id: 'c-1', reason: 'spam' });
		expect(typeof strikes.history[0].at).toBe('number');
	});

	it('disables for one month and resets the count on the third strike', async () => {
		await strike('u1');
		await strike('u1');
		const { strikes, action } = await strike('u1');

		expect(action).toBe('disable_1_month');
		expect(strikes.count).toBe(0);
		expect(strikes.cycles).toBe(1);
		expect(strikes.banned).toBe(false);
		expect(strikes.disabled_until).toBeGreaterThan(Date.now());
		// history is preserved across the cycle reset
		expect(strikes.history).toHaveLength(3);
	});

	it('permanently bans on the second disable cycle (sixth strike)', async () => {
		let last;
		for (let i = 0; i < 6; i++) last = await strike('u1');

		expect(last?.action).toBe('permanent_ban');
		expect(last?.strikes.banned).toBe(true);
		expect(last?.strikes.cycles).toBe(2);
		expect(last?.strikes.count).toBe(0);
	});

	it('caps stored history at 100 entries', async () => {
		for (let i = 0; i < 105; i++) {
			await addStrike(env, 'u1', { ...entry, content_id: `c-${i}` });
		}
		const strikes = await getStrikes(env, 'u1');
		expect(strikes.history).toHaveLength(100);
		// keeps the most recent entries
		expect(strikes.history[strikes.history.length - 1].content_id).toBe('c-104');
		expect(strikes.history[0].content_id).toBe('c-5');
	});

	it('persists the strike state to KV', async () => {
		await strike('u1');
		const stored = await env.KV.get('user:strikes:u1', 'json');
		expect((stored as { count: number }).count).toBe(1);
	});
});

describe('resetStrikes', () => {
	it('clears count, cycles, history, and ban state', async () => {
		for (let i = 0; i < 6; i++) await strike('u1');
		expect((await getStrikes(env, 'u1')).banned).toBe(true);

		const fresh = await resetStrikes(env, 'u1');
		expect(fresh.count).toBe(0);
		expect(fresh.cycles).toBe(0);
		expect(fresh.history).toEqual([]);
		expect(fresh.banned).toBe(false);

		expect((await getStrikes(env, 'u1')).banned).toBe(false);
	});
});
