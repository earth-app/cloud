import { beforeEach, describe, expect, it } from 'vitest';
import {
	addImpactPoints,
	getImpactPoints,
	removeImpactPoints,
	retrievePointsLeaderboard,
	retrievePointsLeaderboardRank,
	setImpactPoints
} from '../../src/user/points';
import { MockKVNamespace } from '../helpers/mock-kv';

describe('getImpactPoints', () => {
	let kv: MockKVNamespace;

	beforeEach(() => {
		kv = new MockKVNamespace();
	});

	it('returns zero and empty history by default', async () => {
		const [points, history] = await getImpactPoints('0007', kv as unknown as KVNamespace);
		expect(points).toBe(0);
		expect(history).toEqual([]);
	});

	it('rebuilds metadata total from history when missing', async () => {
		const key = 'user:impact_points:7';
		await kv.put(
			key,
			JSON.stringify([
				{ reason: 'a', difference: 3 },
				{ reason: 'b', difference: 2 }
			])
		);

		const [points] = await getImpactPoints('0007', kv as unknown as KVNamespace);
		expect(points).toBe(5);

		const repaired = await kv.getWithMetadata<string, { total: number }>(key);
		expect(repaired.metadata?.total).toBe(5);
	});
});

describe('addImpactPoints', () => {
	it('adds points and appends a history record', async () => {
		const kv = new MockKVNamespace();
		const [points, history] = await addImpactPoints('0010', 12, 'Quest reward', kv as any);

		expect(points).toBe(12);
		expect(history).toHaveLength(1);
		expect(history[0].difference).toBe(12);
		expect(history[0].reason).toBe('Quest reward');
	});
});

describe('removeImpactPoints', () => {
	it('never allows total points to go below zero', async () => {
		const kv = new MockKVNamespace();
		await addImpactPoints('11', 5, 'seed', kv as any);

		const [points, history] = await removeImpactPoints('11', 15, 'penalty', kv as any);
		expect(points).toBe(0);
		expect(history[history.length - 1].difference).toBe(-15);
	});
});

describe('setImpactPoints', () => {
	it('sets explicit total and records delta from previous total', async () => {
		const kv = new MockKVNamespace();
		await addImpactPoints('12', 20, 'seed', kv as any);

		const [points, history] = await setImpactPoints('12', 7, 'admin reset', kv as any);
		expect(points).toBe(7);
		expect(history[history.length - 1].difference).toBe(-13);
	});
});

async function seed(kv: MockKVNamespace, id: string, total: number) {
	await kv.put(`user:impact_points:${id}`, JSON.stringify([]), { metadata: { total } });
}

describe('retrievePointsLeaderboard', () => {
	let kv: MockKVNamespace;
	let cache: MockKVNamespace;

	beforeEach(() => {
		kv = new MockKVNamespace();
		cache = new MockKVNamespace();
	});

	it('ranks users by points descending and excludes zero totals', async () => {
		await seed(kv, '1', 100);
		await seed(kv, '2', 300);
		await seed(kv, '3', 0);
		await seed(kv, '4', 50);

		const board = await retrievePointsLeaderboard(
			10,
			kv as unknown as KVNamespace,
			cache as unknown as KVNamespace
		);
		expect(board.map((e) => e.id)).toEqual(['2', '1', '4']);
		expect(board[0].points).toBe(300);
	});

	it('serves the cached result on the second call', async () => {
		await seed(kv, '1', 10);
		await retrievePointsLeaderboard(10, kv as any, cache as any);

		// mutate KV after caching; a cached read should not reflect it
		await seed(kv, '2', 9999);
		const cached = await retrievePointsLeaderboard(10, kv as any, cache as any);
		expect(cached.map((e) => e.id)).toEqual(['1']);
	});

	it('returns a 1-based rank, or 0 when unranked', async () => {
		await seed(kv, '1', 300);
		await seed(kv, '2', 200);
		await seed(kv, '3', 100);

		expect(await retrievePointsLeaderboardRank('2', kv as any, cache as any)).toBe(2);
		expect(await retrievePointsLeaderboardRank('999', kv as any, cache as any)).toBe(0);
	});
});
