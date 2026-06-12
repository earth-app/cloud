import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	addToBlacklist,
	BlacklistEntry,
	isBlacklisted,
	listBlacklist,
	removeFromBlacklist
} from '../../src/admin/blacklist';
import { createMockBindings } from '../helpers/mock-bindings';
import { MockKVNamespace } from '../helpers/mock-kv';

afterEach(() => {
	vi.restoreAllMocks();
});

describe('blacklist', () => {
	let kv: MockKVNamespace;
	let env: ReturnType<typeof createMockBindings>;

	beforeEach(() => {
		kv = new MockKVNamespace();
		env = createMockBindings({ KV: kv as any });
	});

	describe('addToBlacklist', () => {
		it('normalizes the value but keeps the original, and stores both the key and index', async () => {
			const now = 1_700_000_000_000;
			vi.spyOn(Date, 'now').mockReturnValue(now);

			const entry = await addToBlacklist(env, 'username', '  SpamBot  ', 'spamming', 'admin-1');

			expect(entry).toEqual<BlacklistEntry>({
				kind: 'username',
				value: 'spambot',
				original_value: '  SpamBot  ',
				reason: 'spamming',
				added_at: now,
				added_by: 'admin-1'
			});

			// direct key uses the normalized value
			const stored = await kv.get('blacklist:username:spambot');
			expect(stored).not.toBeNull();
			expect(JSON.parse(stored as string)).toEqual(entry);

			// the listing index also contains it
			const index = await kv.get('blacklist:index:username');
			expect(JSON.parse(index as string)).toEqual([entry]);
		});

		it('truncates the reason to 256 characters', async () => {
			const entry = await addToBlacklist(env, 'email', 'a@b.com', 'x'.repeat(500));
			expect(entry.reason).toHaveLength(256);
		});

		it('rejects an empty / whitespace-only value', async () => {
			await expect(addToBlacklist(env, 'username', '   ', 'reason')).rejects.toThrow(
				'Empty blacklist value'
			);
		});

		it('replaces an existing entry for the same value instead of duplicating it', async () => {
			await addToBlacklist(env, 'username', 'dupe', 'first');
			await addToBlacklist(env, 'username', 'DUPE', 'second');

			const entries = await listBlacklist(env, 'username');
			expect(entries).toHaveLength(1);
			expect(entries[0].reason).toBe('second');
		});

		it('keeps username and email indexes separate', async () => {
			await addToBlacklist(env, 'username', 'shared', 'u');
			await addToBlacklist(env, 'email', 'shared', 'e');

			expect(await listBlacklist(env, 'username')).toHaveLength(1);
			expect(await listBlacklist(env, 'email')).toHaveLength(1);
		});
	});

	describe('isBlacklisted', () => {
		it('returns null for an empty candidate without touching KV', async () => {
			const spy = vi.spyOn(kv, 'get');
			expect(await isBlacklisted(env, 'username', '')).toBeNull();
			expect(spy).not.toHaveBeenCalled();
		});

		it('matches an exact entry case-insensitively', async () => {
			await addToBlacklist(env, 'username', 'BadGuy', 'nope');
			const hit = await isBlacklisted(env, 'username', '  badguy  ');
			expect(hit?.value).toBe('badguy');
		});

		it('returns null when nothing matches', async () => {
			await addToBlacklist(env, 'username', 'someone', 'r');
			expect(await isBlacklisted(env, 'username', 'nobody')).toBeNull();
		});

		it('matches a trailing-wildcard entry by prefix', async () => {
			await addToBlacklist(env, 'username', 'spam*', 'prefix block');

			expect((await isBlacklisted(env, 'username', 'spam-bot'))?.value).toBe('spam*');
			expect((await isBlacklisted(env, 'username', 'SPAMMER'))?.value).toBe('spam*');
			// the prefix boundary should not match unrelated names
			expect(await isBlacklisted(env, 'username', 'hamster')).toBeNull();
		});

		it('does not run the wildcard scan when an exact key is found', async () => {
			await addToBlacklist(env, 'username', 'exact', 'r');
			const indexSpy = vi.spyOn(kv, 'get');
			indexSpy.mockClear();

			await isBlacklisted(env, 'username', 'exact');

			// only the exact key lookup, never the index
			expect(indexSpy).toHaveBeenCalledTimes(1);
			expect(indexSpy).toHaveBeenCalledWith('blacklist:username:exact');
		});

		it('falls through to the wildcard scan when the exact key holds corrupt JSON', async () => {
			await addToBlacklist(env, 'username', 'rage*', 'r');
			await kv.put('blacklist:username:ragequit', 'not-json');

			const hit = await isBlacklisted(env, 'username', 'ragequit');
			expect(hit?.value).toBe('rage*');
		});

		it('returns null when the index itself is corrupt JSON', async () => {
			await kv.put('blacklist:index:username', '{not json');
			expect(await isBlacklisted(env, 'username', 'whoever')).toBeNull();
		});
	});

	describe('removeFromBlacklist', () => {
		it('removes an existing entry from both the key and the index', async () => {
			await addToBlacklist(env, 'username', 'gone', 'r');

			const removed = await removeFromBlacklist(env, 'username', 'GONE');
			expect(removed).toBe(true);
			expect(await kv.get('blacklist:username:gone')).toBeNull();
			expect(await listBlacklist(env, 'username')).toHaveLength(0);
			expect(await isBlacklisted(env, 'username', 'gone')).toBeNull();
		});

		it('returns false when the value was not in the index', async () => {
			await addToBlacklist(env, 'username', 'present', 'r');
			expect(await removeFromBlacklist(env, 'username', 'absent')).toBe(false);
		});
	});

	describe('listBlacklist', () => {
		it('returns entries sorted by most-recently-added first', async () => {
			let t = 1_000;
			vi.spyOn(Date, 'now').mockImplementation(() => (t += 1_000));

			await addToBlacklist(env, 'username', 'first', 'r');
			await addToBlacklist(env, 'username', 'second', 'r');
			await addToBlacklist(env, 'username', 'third', 'r');

			const entries = await listBlacklist(env, 'username');
			expect(entries.map((e) => e.value)).toEqual(['third', 'second', 'first']);
		});

		it('merges both kinds when no kind is given', async () => {
			await addToBlacklist(env, 'username', 'u1', 'r');
			await addToBlacklist(env, 'email', 'e1@x.com', 'r');

			const all = await listBlacklist(env);
			expect(all.map((e) => e.kind).sort()).toEqual(['email', 'username']);
		});

		it('returns an empty array when nothing is stored', async () => {
			expect(await listBlacklist(env)).toEqual([]);
		});
	});
});
