import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	addBadgeProgress,
	badges,
	checkAndGrantBadges,
	getBadgeMetadata,
	getNonGrantedBadges,
	getBadgeProgress,
	getGrantedBadges,
	grantBadge,
	isBadgeGranted,
	resetBadgeProgress
} from '../../src/user/badges';
import { createMockBindings } from '../helpers/mock-bindings';
import { MockKVNamespace } from '../helpers/mock-kv';
import * as points from '../../src/user/points';

afterEach(() => {
	vi.restoreAllMocks();
});

describe('badges', () => {
	it('contains known badge definitions with generated names', () => {
		expect(badges.length).toBeGreaterThan(10);
		expect(badges.some((b) => b.id === 'article_enthusiast')).toBe(true);
		expect(badges.every((b) => typeof b.name === 'string' && b.name.length > 0)).toBe(true);
	});
});

describe('addBadgeProgress', () => {
	it('accumulates numeric trackers', async () => {
		const kv = new MockKVNamespace();
		await addBadgeProgress('1', 'impact_points_earned', 10, kv as any);
		await addBadgeProgress('1', 'impact_points_earned', 15, kv as any);

		const tracker = (await kv.get<{ date: number; value: number }[]>(
			'user:badge_tracker:1:impact_points_earned',
			'json'
		)) as { date: number; value: number }[] | null;
		expect(tracker).toHaveLength(1);
		expect(tracker?.[0]?.value).toBe(25);
	});

	it('throws when duplicate string tracker values are submitted', async () => {
		const kv = new MockKVNamespace();
		await expect(
			addBadgeProgress('2', 'articles_read', ['001', '001', '002'], kv as any)
		).rejects.toThrow('Duplicate badge tracker data is not allowed for tracker articles_read');
		expect(await kv.get('user:badge_tracker:2:articles_read')).toBeNull();
	});

	it('keeps duplicate-allowed tracker values on read-time badges', async () => {
		const kv = new MockKVNamespace();
		await addBadgeProgress('2', 'articles_read_time', [30, 30], kv as any);
		const tracker = (await kv.get<{ date: number; value: number }[]>(
			'user:badge_tracker:2:articles_read_time',
			'json'
		)) as { date: number; value: number }[] | null;

		expect(tracker).toHaveLength(1);
		expect(tracker?.[0]?.value).toBe(60);
	});

	it('rejects mixed-type writes for existing string trackers', async () => {
		const kv = new MockKVNamespace();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

		await addBadgeProgress('9', 'articles_read', ['a1'], kv as any);
		await addBadgeProgress('9', 'articles_read', 5, kv as any);

		const tracker = (await kv.get<{ value: string }[]>(
			'user:badge_tracker:9:articles_read',
			'json'
		)) as { value: string }[] | null;
		expect(tracker?.map((entry) => entry.value)).toEqual(['a1']);
		expect(warn).toHaveBeenCalledWith('Attempted to add numbers to string tracker: articles_read');
	});

	it('rejects mixed-type writes for existing number trackers', async () => {
		const kv = new MockKVNamespace();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

		await addBadgeProgress('10', 'impact_points_earned', 25, kv as any);
		await addBadgeProgress('10', 'impact_points_earned', ['abc'], kv as any);

		const tracker = (await kv.get<{ value: number }[]>(
			'user:badge_tracker:10:impact_points_earned',
			'json'
		)) as { value: number }[] | null;
		expect(tracker?.[0]?.value).toBe(25);
		expect(warn).toHaveBeenCalledWith(
			'Attempted to add strings to number tracker: impact_points_earned'
		);
	});

	it('silently rejects duplicate values for articles_read_time (mind_explorer tracker)', async () => {
		const kv = new MockKVNamespace();
		// Add 3600 seconds once with metadata
		await addBadgeProgress('11', 'articles_read_time', 3600, kv as any, {
			article: { id: 'article-1' }
		});

		const tracker = (await kv.get<{ date: number; value: number }[]>(
			'user:badge_tracker:11:articles_read_time',
			'json'
		)) as { date: number; value: number }[] | null;

		// Should have 1 entry
		expect(tracker).toHaveLength(1);
		expect(tracker?.[0]?.value).toBe(3600);

		// Progress for mind_explorer should be 1.0 (met the 1 hour requirement)
		const mindExplorerProgress = await getBadgeProgress('11', 'mind_explorer', kv as any);
		expect(mindExplorerProgress).toBe(1);
	});

	it('silent rejection deduplicates during progress calculation for mind_explorer', async () => {
		const kv = new MockKVNamespace();
		// Add 1800 seconds twice with different metadata
		await addBadgeProgress('12', 'articles_read_time', 1800, kv as any, {
			article: { id: 'article-a' }
		});
		await addBadgeProgress('12', 'articles_read_time', 1800, kv as any, {
			article: { id: 'article-b' }
		});

		// The tracker stores both entries (different metadata)
		const tracker = (await kv.get<{ date: number; value: number }[]>(
			'user:badge_tracker:12:articles_read_time',
			'json'
		)) as { date: number; value: number }[] | null;
		expect(tracker).toHaveLength(2);
		expect(tracker?.every((entry) => entry.value === 1800)).toBe(true);

		// For bookworm (allows_duplicate_data), it sums values: 1800 + 1800 = 3600
		const bookwormProgress = await getBadgeProgress('12', 'bookworm', kv as any);
		expect(bookwormProgress).toBe(1); // 3600 seconds

		// For mind_explorer (silently_reject_duplicate_data), it dedupes by value before summing
		// Both entries have value 1800, so after dedup it counts as one unique 1800
		const mindExplorerProgress = await getBadgeProgress('12', 'mind_explorer', kv as any);
		expect(mindExplorerProgress).toBe(0.5); // Only 1800 seconds (unique values only)
	});
});

describe('getBadgeProgress', () => {
	it('calculates normalized progress from tracker values', async () => {
		const kv = new MockKVNamespace();
		await addBadgeProgress(
			'3',
			'articles_read',
			['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'a10'],
			kv as any
		);

		const progress = await getBadgeProgress('3', 'article_enthusiast', kv as any);
		expect(progress).toBe(1);
	});

	it('deduplicates stored tracker entries when computing progress', async () => {
		const kv = new MockKVNamespace();
		await kv.put(
			'user:badge_tracker:3:articles_read',
			JSON.stringify([
				{ date: 1, value: 'a1' },
				{ date: 2, value: 'a1' },
				{ date: 3, value: 'a2' }
			])
		);

		const progress = await getBadgeProgress('3', 'article_enthusiast', kv as any);
		expect(progress).toBe(0.2);

		const tracker = (await kv.get<{ date: number; value: string }[]>(
			'user:badge_tracker:3:articles_read',
			'json'
		)) as { date: number; value: string }[] | null;
		expect((tracker || []).map((entry) => entry.value)).toEqual(['a1', 'a2']);
	});

	it('returns 0 for unknown badges and resolves one-time badge progress by grant status', async () => {
		const kv = new MockKVNamespace();
		expect(await getBadgeProgress('11', 'does_not_exist', kv as any)).toBe(0);
		expect(await getBadgeProgress('11', 'verified', kv as any)).toBe(0);

		await grantBadge('11', 'verified', kv as any);
		expect(await getBadgeProgress('11', 'verified', kv as any)).toBe(1);
	});

	it('supports legacy padded tracker keys and migrates them', async () => {
		const kv = new MockKVNamespace();
		await kv.put(
			'user:badge_tracker:00000123:impact_points_earned',
			JSON.stringify([
				{ date: 1, value: [5, 10] },
				{ date: 2, value: 20 }
			])
		);

		const progress = await getBadgeProgress('00000123', 'impacter', kv as any);
		expect(progress).toBeCloseTo(0.2);
		expect(await kv.get('user:badge_tracker:123:impact_points_earned')).not.toBeNull();
		expect(await kv.get('user:badge_tracker:00000123:impact_points_earned')).toBeNull();
	});
});

describe('grantBadge and isBadgeGranted', () => {
	it('grants badge metadata and reports granted status', async () => {
		const kv = new MockKVNamespace();
		await grantBadge('4', 'getting_started', kv as any);

		expect(await isBadgeGranted('4', 'getting_started', kv as any)).toBe(true);
		const granted = await getGrantedBadges('4', kv as any);
		expect(granted).toContain('getting_started');
	});

	it('does not throw when impact point award side effects fail', async () => {
		const kv = new MockKVNamespace();
		const addPoints = vi
			.spyOn(points, 'addImpactPoints')
			.mockRejectedValueOnce(new Error('points subsystem unavailable'));
		const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

		await expect(grantBadge('12', 'getting_started', kv as any)).resolves.toBeUndefined();
		expect(addPoints).toHaveBeenCalled();
		expect(error).toHaveBeenCalled();
		expect(await isBadgeGranted('12', 'getting_started', kv as any)).toBe(true);
	});

	it('returns early for impact-points-based badges without recursive point grants', async () => {
		const kv = new MockKVNamespace();
		const addPoints = vi.spyOn(points, 'addImpactPoints');

		await grantBadge('13', 'impacter', kv as any);

		expect(await isBadgeGranted('13', 'impacter', kv as any)).toBe(true);
		expect(addPoints).not.toHaveBeenCalled();
	});
});

describe('badge metadata and listing helpers', () => {
	it('migrates legacy padded metadata keys and merges legacy badge lists', async () => {
		const kv = new MockKVNamespace();
		await kv.put('user:badge:123:verified', JSON.stringify({ granted_at: 1000 }));
		await kv.put('user:badge:00000123:getting_started', JSON.stringify({ granted_at: 2000 }));

		const metadata = await getBadgeMetadata('00000123', 'getting_started', kv as any);
		expect(metadata?.granted_at).toBe(2000);
		expect(await kv.get('user:badge:123:getting_started')).not.toBeNull();
		expect(await kv.get('user:badge:00000123:getting_started')).toBeNull();

		const granted = await getGrantedBadges('00000123', kv as any);
		expect(new Set(granted)).toEqual(new Set(['verified', 'getting_started']));

		const nonGranted = await getNonGrantedBadges('123', kv as any);
		expect(nonGranted).not.toContain('verified');
		expect(nonGranted).not.toContain('getting_started');
	});
});

describe('resetBadgeProgress', () => {
	it('deletes tracker state and revokes badge', async () => {
		const kv = new MockKVNamespace();
		await addBadgeProgress('5', 'articles_read', ['a1', 'a2'], kv as any);
		await grantBadge('5', 'article_enthusiast', kv as any);

		await resetBadgeProgress('5', 'article_enthusiast', kv as any);

		expect(await isBadgeGranted('5', 'article_enthusiast', kv as any)).toBe(false);
		expect(await kv.get('user:badge_tracker:5:articles_read')).toBeNull();
	});

	it('no-ops for badges without trackers', async () => {
		const kv = new MockKVNamespace();
		await expect(resetBadgeProgress('5', 'verified', kv as any)).resolves.toBeUndefined();
	});
});

describe('checkAndGrantBadges', () => {
	it('grants eligible badges for tracker updates', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
		const kv = new MockKVNamespace();
		const bindings = createMockBindings({ KV: kv as any });
		const ctx = { waitUntil: vi.fn((promise: Promise<unknown>) => void promise) };

		await addBadgeProgress(
			'6',
			'articles_read',
			['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'a10'],
			kv as any
		);

		const granted = await checkAndGrantBadges('6', 'articles_read', bindings, ctx as any);
		expect(granted).toContain('article_enthusiast');
	});

	it('handles no relevant trackers and still resolves without throwing', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
		const kv = new MockKVNamespace();
		const bindings = createMockBindings({ KV: kv as any });
		const ctx = { waitUntil: vi.fn((promise: Promise<unknown>) => void promise) };

		const granted = await checkAndGrantBadges(
			'7',
			'non_existent_tracker' as any,
			bindings,
			ctx as any
		);
		expect(granted).toEqual([]);
		expect(ctx.waitUntil).toHaveBeenCalledOnce();
	});

	it('formats plural grant notifications when multiple badges unlock at once', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
		const kv = new MockKVNamespace();
		const bindings = createMockBindings({ KV: kv as any });
		const ctx = { waitUntil: vi.fn((promise: Promise<unknown>) => void promise) };

		await addBadgeProgress(
			'8',
			'articles_read',
			Array.from({ length: 50 }, (_, i) => `article-${i}`),
			kv as any
		);

		const granted = await checkAndGrantBadges('8', 'articles_read', bindings, ctx as any);
		expect(granted).toEqual(expect.arrayContaining(['article_enthusiast', 'avid_reader']));
		expect(granted.length).toBeGreaterThan(1);
	});
});
