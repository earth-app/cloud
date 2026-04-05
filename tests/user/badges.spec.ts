import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	addBadgeProgress,
	badges,
	checkAndGrantBadges,
	getBadgeProgress,
	getGrantedBadges,
	grantBadge,
	isBadgeGranted,
	resetBadgeProgress
} from '../../src/user/badges';
import { createMockBindings } from '../helpers/mock-bindings';
import { MockKVNamespace } from '../helpers/mock-kv';

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

	it('deduplicates string tracker values', async () => {
		const kv = new MockKVNamespace();
		await addBadgeProgress('2', 'articles_read', ['001', '001', '002'], kv as any);
		const tracker = (await kv.get<{ date: number; value: string }[]>(
			'user:badge_tracker:2:articles_read',
			'json'
		)) as { date: number; value: string }[] | null;

		expect((tracker || []).map((t: { date: number; value: string }) => t.value)).toEqual([
			'1',
			'2'
		]);
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
});

describe('grantBadge and isBadgeGranted', () => {
	it('grants badge metadata and reports granted status', async () => {
		const kv = new MockKVNamespace();
		await grantBadge('4', 'getting_started', kv as any);

		expect(await isBadgeGranted('4', 'getting_started', kv as any)).toBe(true);
		const granted = await getGrantedBadges('4', kv as any);
		expect(granted).toContain('getting_started');
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
});
