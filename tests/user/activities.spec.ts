import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	activityFingerprint,
	activityIdsOf,
	applyActivityChange,
	diffActivities,
	getActivitySnapshot,
	MAX_SURFACED_QUESTS,
	setActivitySnapshot
} from '../../src/user/activities';
import { createMockBindings } from '../helpers/mock-bindings';
import { MockKVNamespace } from '../helpers/mock-kv';
import * as profile from '../../src/user/profile';
import * as notifications from '../../src/user/notifications';
import type { UserProfilePromptData } from '../../src/util/ai';

afterEach(() => {
	vi.restoreAllMocks();
});

function ctx() {
	const pending: Promise<unknown>[] = [];
	return {
		ctx: { waitUntil: vi.fn((p: Promise<unknown>) => void pending.push(Promise.resolve(p))) },
		settle: async () => {
			await Promise.allSettled(pending);
		}
	};
}

function payload(ids: string[]): UserProfilePromptData {
	return {
		username: 'earthy',
		bio: '',
		created_at: '2026-01-01',
		visibility: 'PUBLIC' as never,
		country: 'US',
		full_name: 'Earth User',
		activities: ids.map((id) => ({
			id,
			name: id.replace(/_/g, ' '),
			description: 'desc',
			types: ['HOBBY'] as never,
			aliases: []
		})) as never
	};
}

describe('activityFingerprint', () => {
	it('is empty for an empty set so existing gardens keep their arrangement', () => {
		expect(activityFingerprint([])).toBe('');
		expect(activityFingerprint(['  ', ''])).toBe('');
	});

	it('ignores order and case', () => {
		expect(activityFingerprint(['karting', 'reading'])).toBe(
			activityFingerprint(['Reading', 'KARTING'])
		);
	});

	it('changes when the set changes', () => {
		const before = activityFingerprint(['karting', 'reading']);
		expect(activityFingerprint(['karting'])).not.toBe(before);
		expect(activityFingerprint(['karting', 'reading', 'debate'])).not.toBe(before);
	});

	it('treats a duplicate as no change', () => {
		expect(activityFingerprint(['karting', 'karting'])).toBe(activityFingerprint(['karting']));
	});
});

describe('diffActivities', () => {
	it('reports both directions', () => {
		const diff = diffActivities(['a', 'b'], ['b', 'c']);
		expect(diff.added).toEqual(['c']);
		expect(diff.removed).toEqual(['a']);
		expect(diff.next).toEqual(['b', 'c']);
	});

	it('is empty for a reorder', () => {
		const diff = diffActivities(['a', 'b'], ['b', 'a']);
		expect(diff.added).toEqual([]);
		expect(diff.removed).toEqual([]);
	});

	it('normalizes case and blanks', () => {
		const diff = diffActivities(['A'], [' a ', '']);
		expect(diff.added).toEqual([]);
		expect(diff.removed).toEqual([]);
	});
});

describe('activityIdsOf', () => {
	it('prefers the id mantle2 sends', () => {
		expect(activityIdsOf(payload(['cross_country']))).toEqual(['cross_country']);
	});

	it('falls back to a slugged name when no id is present', () => {
		const data = {
			...payload([]),
			activities: [{ name: 'Cross Country', description: '', types: [], aliases: [] }]
		} as unknown as UserProfilePromptData;
		expect(activityIdsOf(data)).toEqual(['cross_country']);
	});

	it('tolerates a missing activities array', () => {
		expect(activityIdsOf({ activities: undefined } as unknown as UserProfilePromptData)).toEqual(
			[]
		);
	});
});

describe('activity snapshot', () => {
	it('round-trips through KV', async () => {
		const kv = new MockKVNamespace();
		await setActivitySnapshot('00042', ['karting'], kv as never);
		expect(await getActivitySnapshot('42', kv as never)).toEqual(['karting']);
	});

	it('returns nothing for a missing or corrupt entry', async () => {
		const kv = new MockKVNamespace();
		expect(await getActivitySnapshot('42', kv as never)).toEqual([]);

		await kv.put('user:activities:42', 'not json');
		expect(await getActivitySnapshot('42', kv as never)).toEqual([]);

		await kv.put('user:activities:42', '{"not":"an array"}');
		expect(await getActivitySnapshot('42', kv as never)).toEqual([]);
	});
});

describe('applyActivityChange', () => {
	it('regenerates the photo and surfaces a quest for a newly added activity', async () => {
		const bindings = createMockBindings();
		const photo = vi.spyOn(profile, 'newProfilePhoto').mockResolvedValue(new Uint8Array([1]));
		const notify = vi
			.spyOn(notifications, 'sendUserNotification')
			.mockResolvedValue(new Response(null, { status: 200 }));
		const { ctx: executionCtx, settle } = ctx();

		const result = await applyActivityChange('42', payload(['karting']), bindings, executionCtx);
		await settle();

		expect(result).toMatchObject({
			changed: true,
			added: ['karting'],
			removed: [],
			quests_surfaced: ['activity_quest_karting'],
			photo_queued: true
		});
		expect(photo).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0]![4]).toBe('/quests/activity_quest_karting');
		expect(await getActivitySnapshot('42', bindings.KV)).toEqual(['karting']);
	});

	it('does nothing the second time the same list arrives', async () => {
		const bindings = createMockBindings();
		const photo = vi.spyOn(profile, 'newProfilePhoto').mockResolvedValue(new Uint8Array([1]));
		vi.spyOn(notifications, 'sendUserNotification').mockResolvedValue(
			new Response(null, { status: 200 })
		);
		const first = ctx();

		await applyActivityChange('42', payload(['karting']), bindings, first.ctx);
		await first.settle();
		expect(photo).toHaveBeenCalledTimes(1);

		const second = ctx();
		const result = await applyActivityChange('42', payload(['karting']), bindings, second.ctx);
		await second.settle();

		expect(result).toEqual({
			changed: false,
			added: [],
			removed: [],
			quests_surfaced: [],
			photo_queued: false
		});
		// no second image generation, which is the whole point of the snapshot
		expect(photo).toHaveBeenCalledTimes(1);
	});

	it('regenerates the photo on a removal but surfaces no quest', async () => {
		const bindings = createMockBindings();
		await setActivitySnapshot('42', ['karting', 'reading'], bindings.KV);
		const photo = vi.spyOn(profile, 'newProfilePhoto').mockResolvedValue(new Uint8Array([1]));
		const notify = vi
			.spyOn(notifications, 'sendUserNotification')
			.mockResolvedValue(new Response(null, { status: 200 }));
		const { ctx: executionCtx, settle } = ctx();

		const result = await applyActivityChange('42', payload(['karting']), bindings, executionCtx);
		await settle();

		expect(result.removed).toEqual(['reading']);
		expect(result.quests_surfaced).toEqual([]);
		expect(photo).toHaveBeenCalledTimes(1);
		expect(notify).not.toHaveBeenCalled();
	});

	it('caps how many quests one change advertises', async () => {
		const bindings = createMockBindings();
		vi.spyOn(profile, 'newProfilePhoto').mockResolvedValue(new Uint8Array([1]));
		const notify = vi
			.spyOn(notifications, 'sendUserNotification')
			.mockResolvedValue(new Response(null, { status: 200 }));
		const { ctx: executionCtx, settle } = ctx();

		const result = await applyActivityChange(
			'42',
			payload(['a1', 'a2', 'a3', 'a4', 'a5']),
			bindings,
			executionCtx
		);
		await settle();

		expect(result.added).toHaveLength(5);
		expect(result.quests_surfaced).toHaveLength(MAX_SURFACED_QUESTS);
		expect(notify.mock.calls[0]![3]).toContain('and');
	});

	it('keeps the snapshot and the diff when the photo generation fails', async () => {
		const bindings = createMockBindings();
		vi.spyOn(profile, 'newProfilePhoto').mockRejectedValue(new Error('model down'));
		vi.spyOn(notifications, 'sendUserNotification').mockResolvedValue(
			new Response(null, { status: 200 })
		);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const { ctx: executionCtx, settle } = ctx();

		const result = await applyActivityChange('42', payload(['karting']), bindings, executionCtx);
		await settle();

		expect(result.changed).toBe(true);
		expect(await getActivitySnapshot('42', bindings.KV)).toEqual(['karting']);
		expect(warn).toHaveBeenCalled();
	});

	it('survives a notification failure', async () => {
		const bindings = createMockBindings();
		vi.spyOn(profile, 'newProfilePhoto').mockResolvedValue(new Uint8Array([1]));
		vi.spyOn(notifications, 'sendUserNotification').mockRejectedValue(new Error('mantle down'));
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const { ctx: executionCtx, settle } = ctx();

		const result = await applyActivityChange('42', payload(['karting']), bindings, executionCtx);
		await settle();

		expect(result.changed).toBe(true);
		expect(warn).toHaveBeenCalled();
	});

	it('takes an explicit id list over the payload', async () => {
		const bindings = createMockBindings();
		vi.spyOn(profile, 'newProfilePhoto').mockResolvedValue(new Uint8Array([1]));
		vi.spyOn(notifications, 'sendUserNotification').mockResolvedValue(
			new Response(null, { status: 200 })
		);
		const { ctx: executionCtx, settle } = ctx();

		const result = await applyActivityChange('42', payload(['ignored']), bindings, executionCtx, [
			'explicit'
		]);
		await settle();

		expect(result.added).toEqual(['explicit']);
		expect(await getActivitySnapshot('42', bindings.KV)).toEqual(['explicit']);
	});
});
