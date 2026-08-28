import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	PERSONAL_BEST_BONUS,
	TOP_LEADERBOARD_COUNT,
	addActivityToJourney,
	getActivityJourney,
	getJourney,
	getJourneyBest,
	incrementJourney,
	resetJourney,
	retrieveLeaderboard,
	retrieveLeaderboardRank,
	touchJourney
} from '../../src/user/journies';
import { MockKVNamespace } from '../helpers/mock-kv';
import * as points from '../../src/user/points';

describe('getJourney', () => {
	it('throws for unsupported journey type', async () => {
		await expect(getJourney('1', 'invalid', new MockKVNamespace() as any)).rejects.toThrow(
			'Invalid journey type'
		);
	});

	it('returns [0, 0] when no data exists', async () => {
		const [streak, lastWrite] = await getJourney('10', 'article', new MockKVNamespace() as any);
		expect(streak).toBe(0);
		expect(lastWrite).toBe(0);
	});

	it('migrates legacy padded journey keys', async () => {
		const kv = new MockKVNamespace();
		await kv.put('journey:article:00000123', '7', {
			metadata: { streak: 7, lastWrite: 1234 }
		});

		const [streak, lastWrite] = await getJourney('00000123', 'article', kv as any);
		expect(streak).toBe(7);
		expect(lastWrite).toBe(1234);
		expect(await kv.get('journey:article:123')).toBe('7');
		expect(await kv.get('journey:article:00000123')).toBeNull();
	});
});

describe('touchJourney', () => {
	it('throws for unsupported journey type', async () => {
		await expect(touchJourney('1', 'invalid', 3, new MockKVNamespace() as any)).rejects.toThrow(
			'Invalid journey type'
		);
	});

	it('keeps the streak in metadata when only refreshing the window', async () => {
		const kv = new MockKVNamespace();
		await kv.put('journey:article:42', '2', { metadata: { streak: 2, lastWrite: 1 } });

		await touchJourney('42', 'article', 2, kv as any);

		const [streak, lastWrite] = await getJourney('42', 'article', kv as any);
		expect(streak).toBe(2);
		expect(lastWrite).toBeGreaterThan(1);
		expect(await kv.get('journey:article:42')).toBe('2');
	});

	it('normalizes legacy padded ids onto the canonical key', async () => {
		const kv = new MockKVNamespace();

		await touchJourney('00000042', 'article', 5, kv as any);

		expect(await kv.get('journey:article:42')).toBe('5');
		expect(await kv.get('journey:article:00000042')).toBeNull();
	});
});

describe('incrementJourney', () => {
	it('increments streak and stores metadata', async () => {
		const kv = new MockKVNamespace();
		const ctx = { waitUntil: vi.fn((promise: Promise<unknown>) => void promise) };

		const value = await incrementJourney('00042', 'article', kv as any, ctx as any);
		expect(value).toBe(1);

		const [streak, lastWrite] = await getJourney('42', 'article', kv as any);
		expect(streak).toBe(1);
		expect(lastWrite).toBeGreaterThan(0);
	});

	it('clears leaderboard cache when incrementing', async () => {
		const kv = new MockKVNamespace();
		const cache = new MockKVNamespace();
		const ctx = { waitUntil: vi.fn((promise: Promise<unknown>) => void promise) };

		await kv.put('journey:article:42', '3', {
			metadata: { streak: 3, lastWrite: 1 }
		});
		await cache.put(
			'leaderboard:article',
			JSON.stringify([
				{ id: '1', streak: 999 },
				{ id: '2', streak: 998 }
			])
		);

		const value = await incrementJourney('42', 'article', kv as any, ctx as any, cache as any);
		expect(value).toBe(4);
		expect(await cache.get('leaderboard:article')).toBeNull();
	});

	it('deletes legacy key and continues when impact-point side effects fail', async () => {
		const kv = new MockKVNamespace();
		await kv.put('journey:article:00000444', '3', {
			metadata: { streak: 3, lastWrite: 1 }
		});

		vi.spyOn(points, 'addImpactPoints').mockRejectedValue(new Error('transient failure'));
		const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const ctx = { waitUntil: vi.fn((promise: Promise<unknown>) => void promise) };

		const value = await incrementJourney('00000444', 'article', kv as any, ctx as any);
		expect(value).toBe(4);
		expect(await kv.get('journey:article:00000444')).toBeNull();
		expect(await kv.get('journey:article:444')).not.toBeNull();
		expect(error).toHaveBeenCalled();
	});
});

describe('journey personal best', () => {
	// the suite above leaves an addImpactPoints spy in place, so call counts here need a clean slate
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it('returns 0 with nothing on record', async () => {
		const kv = new MockKVNamespace();
		expect(await getJourneyBest('42', 'article', kv as any)).toBe(0);
	});

	it('throws for unsupported journey type', async () => {
		await expect(getJourneyBest('42', 'invalid', new MockKVNamespace() as any)).rejects.toThrow(
			'Invalid journey type'
		);
	});

	it('normalizes legacy padded ids when reading the record', async () => {
		const kv = new MockKVNamespace();
		await kv.put('journey:best:article:42', '9');
		expect(await getJourneyBest('00000042', 'article', kv as any)).toBe(9);
	});

	it('ignores a corrupt record rather than reporting a negative best', async () => {
		const kv = new MockKVNamespace();
		await kv.put('journey:best:article:42', 'not-a-number');
		expect(await getJourneyBest('42', 'article', kv as any)).toBe(0);
	});

	it('pays the flat personal-best bonus when the streak sets a new record', async () => {
		const kv = new MockKVNamespace();
		const ctx = { waitUntil: vi.fn(async (promise: Promise<unknown>) => void (await promise)) };
		const add = vi.spyOn(points, 'addImpactPoints').mockResolvedValue(undefined as any);

		await incrementJourney('42', 'article', kv as any, ctx as any);
		await Promise.all(ctx.waitUntil.mock.results.map((r) => r.value));

		expect(add).toHaveBeenCalledWith('42', 5, 'Article Journey', kv);
		expect(add).toHaveBeenCalledWith(
			'42',
			PERSONAL_BEST_BONUS,
			'Article Journey Personal Best (1)',
			kv
		);
		expect(await getJourneyBest('42', 'article', kv as any)).toBe(1);
	});

	it('pays nothing extra while the streak is still under the record', async () => {
		const kv = new MockKVNamespace();
		const ctx = { waitUntil: vi.fn(async (promise: Promise<unknown>) => void (await promise)) };
		await kv.put('journey:best:article:42', '10');
		const add = vi.spyOn(points, 'addImpactPoints').mockResolvedValue(undefined as any);

		await incrementJourney('42', 'article', kv as any, ctx as any);
		await Promise.all(ctx.waitUntil.mock.results.map((r) => r.value));

		expect(add).toHaveBeenCalledTimes(1);
		expect(add).toHaveBeenCalledWith('42', 5, 'Article Journey', kv);
		// the record must not be walked backwards by a shorter run
		expect(await getJourneyBest('42', 'article', kv as any)).toBe(10);
	});

	// regression: the bonus used to be 260-rank, so rank #1 was worth 259 points per increment
	it('never pays a bonus that depends on leaderboard rank', async () => {
		const kv = new MockKVNamespace();
		const cache = new MockKVNamespace();
		const ctx = { waitUntil: vi.fn(async (promise: Promise<unknown>) => void (await promise)) };

		// sole entry, so this user is rank #1 on every read
		await kv.put('journey:article:42', '3', { metadata: { streak: 3, lastWrite: 1 } });
		const add = vi.spyOn(points, 'addImpactPoints').mockResolvedValue(undefined as any);

		await incrementJourney('42', 'article', kv as any, ctx as any, cache as any);
		await Promise.all(ctx.waitUntil.mock.results.map((r) => r.value));

		const awarded = add.mock.calls.map((call) => call[1]);
		expect(awarded).toEqual([5, PERSONAL_BEST_BONUS]);
		expect(add.mock.calls.every((call) => !String(call[2]).includes('Rank'))).toBe(true);
	});

	it('keeps the record after the 48h streak key expires', async () => {
		const kv = new MockKVNamespace();
		const ctx = { waitUntil: vi.fn(async (promise: Promise<unknown>) => void (await promise)) };
		vi.spyOn(points, 'addImpactPoints').mockResolvedValue(undefined as any);

		await kv.put('journey:article:42', '6', { metadata: { streak: 6, lastWrite: 1 } });
		await incrementJourney('42', 'article', kv as any, ctx as any);
		await Promise.all(ctx.waitUntil.mock.results.map((r) => r.value));
		expect(await getJourneyBest('42', 'article', kv as any)).toBe(7);

		// streak lapses; the record is on a separate untimed key
		await kv.delete('journey:article:42');
		expect(await getJourneyBest('42', 'article', kv as any)).toBe(7);
	});
});

describe('retrieveLeaderboard', () => {
	it('sorts entries by streak descending and respects limit cap', async () => {
		const kv = new MockKVNamespace();
		const cache = new MockKVNamespace();
		await kv.put('journey:article:1', '1', { metadata: { streak: 3, lastWrite: 1 } });
		await kv.put('journey:article:2', '1', { metadata: { streak: 9, lastWrite: 1 } });
		await kv.put('journey:article:3', '1', { metadata: { streak: 1, lastWrite: 1 } });

		const list = await retrieveLeaderboard(
			'article',
			TOP_LEADERBOARD_COUNT,
			kv as any,
			cache as any
		);
		expect(list[0]).toEqual({ id: '2', streak: 9 });
		expect(list[1]).toEqual({ id: '1', streak: 3 });
	});

	it('throws for unsupported journey types', async () => {
		const kv = new MockKVNamespace();
		const cache = new MockKVNamespace();
		await expect(retrieveLeaderboard('unknown', 10, kv as any, cache as any)).rejects.toThrow(
			'Invalid journey type'
		);
	});
});

describe('retrieveLeaderboardRank', () => {
	it('returns 1-based rank for user in leaderboard', async () => {
		const kv = new MockKVNamespace();
		const cache = new MockKVNamespace();
		await kv.put('journey:article:100', '1', { metadata: { streak: 8, lastWrite: 1 } });
		await kv.put('journey:article:200', '1', { metadata: { streak: 4, lastWrite: 1 } });

		const rank = await retrieveLeaderboardRank('200', 'article', kv as any, cache as any);
		expect(rank).toBe(2);
	});

	it('returns 0 for users without a streak', async () => {
		const rank = await retrieveLeaderboardRank(
			'777',
			'article',
			new MockKVNamespace() as any,
			new MockKVNamespace() as any
		);
		expect(rank).toBe(0);
	});

	it('rebuilds a stale cached leaderboard and returns the fresh rank', async () => {
		const kv = new MockKVNamespace();
		const cache = new MockKVNamespace();

		await kv.put('journey:article:999', '999', {
			metadata: { streak: 999, lastWrite: Date.now() }
		});

		const staleLeaderboard = Array.from({ length: TOP_LEADERBOARD_COUNT }, (_, i) => ({
			id: String(i + 1),
			streak: TOP_LEADERBOARD_COUNT - i
		}));
		await cache.put('leaderboard:article', JSON.stringify(staleLeaderboard));

		const rank = await retrieveLeaderboardRank('999', 'article', kv as any, cache as any);
		expect(rank).toBe(1);
		expect(await cache.get('leaderboard:article')).toBeTruthy();
	});
});

describe('activity journey helpers', () => {
	it('adds unique activities only once', async () => {
		const kv = new MockKVNamespace();
		await addActivityToJourney('55', 'hiking', kv as any);
		await addActivityToJourney('55', 'hiking', kv as any);
		await addActivityToJourney('55', 'coding', kv as any);

		expect(await getActivityJourney('55', kv as any)).toEqual(['hiking', 'coding']);
	});

	it('resets a journey key', async () => {
		const kv = new MockKVNamespace();
		await kv.put('journey:event:77', '2', { metadata: { streak: 2, lastWrite: Date.now() } });
		await resetJourney('77', 'event', kv as any);

		const [count] = await getJourney('77', 'event', kv as any);
		expect(count).toBe(0);
	});

	it('clears leaderboard cache when resetting', async () => {
		const kv = new MockKVNamespace();
		const cache = new MockKVNamespace();
		await kv.put('journey:event:77', '2', { metadata: { streak: 2, lastWrite: Date.now() } });
		await cache.put('leaderboard:event', JSON.stringify([{ id: '77', streak: 2 }]));

		await resetJourney('77', 'event', kv as any, cache as any);

		expect(await cache.get('leaderboard:event')).toBeNull();
	});

	it('reads and migrates legacy padded activity journeys', async () => {
		const kv = new MockKVNamespace();
		await kv.put('journey:activities:00000123', JSON.stringify(['hiking', 'reading']));

		const activities = await getActivityJourney('00000123', kv as any);
		expect(activities).toEqual(['hiking', 'reading']);
		expect(await kv.get('journey:activities:123')).toBe(JSON.stringify(['hiking', 'reading']));
		expect(await kv.get('journey:activities:00000123')).toBeNull();
	});

	it('throws when resetting an unsupported journey type', async () => {
		await expect(resetJourney('1', 'unsupported', new MockKVNamespace() as any)).rejects.toThrow(
			'Invalid journey type'
		);
	});
});
