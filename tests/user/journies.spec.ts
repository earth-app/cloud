import { describe, expect, it, vi } from 'vitest';
import {
	TOP_LEADERBOARD_COUNT,
	addActivityToJourney,
	getActivityJourney,
	getJourney,
	incrementJourney,
	resetJourney,
	retrieveLeaderboard,
	retrieveLeaderboardRank
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

	it('returns 0 when cached leaderboard is stale and user should be in top list', async () => {
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
		expect(rank).toBe(0);
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
