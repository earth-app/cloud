import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	isNumericId,
	isUserIdShape,
	isUuidHexId,
	rememberUserAlias,
	resolveEntityId,
	resolveUserId
} from '../../src/util/ids';
import { createMockBindings } from '../helpers/mock-bindings';

const HEX = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

let fetchSpy: ReturnType<typeof vi.spyOn>;

function mantleReplies(body: unknown, ok = true) {
	fetchSpy.mockResolvedValue({
		ok,
		status: ok ? 200 : 404,
		json: async () => body
	} as unknown as Response);
}

beforeEach(() => {
	fetchSpy = vi.spyOn(globalThis, 'fetch');
	vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('id shapes', () => {
	it('accepts both shapes mantle2 may have issued', () => {
		expect(isUserIdShape('2')).toBe(true);
		expect(isUserIdShape('000000000000000000000002')).toBe(true);
		expect(isUserIdShape(HEX)).toBe(true);
	});

	it('rejects anything else, including a dashed uuid and the wrong length', () => {
		expect(isUserIdShape('a1b2c3d4-e5f6-0718-293a-4b5c6d7e8f90')).toBe(false);
		expect(isUserIdShape(HEX.slice(0, 31))).toBe(false);
		expect(isUserIdShape(`${HEX}0`)).toBe(false);
		expect(isUserIdShape('not-an-id')).toBe(false);
		expect(isUserIdShape('')).toBe(false);
		expect(isUserIdShape(undefined)).toBe(false);
		expect(isUserIdShape(null)).toBe(false);
	});

	it('rejects uppercase hex, so one account cannot key two aliases', () => {
		expect(isUuidHexId(HEX.toUpperCase())).toBe(false);
		expect(isUserIdShape(HEX.toUpperCase())).toBe(false);
	});

	it('separates the two shapes', () => {
		expect(isNumericId('42')).toBe(true);
		expect(isNumericId(HEX)).toBe(false);
		expect(isUuidHexId('42')).toBe(false);
	});
});

describe('resolveUserId', () => {
	it('canonicalises a numeric id with no round trip', async () => {
		const bindings = createMockBindings();

		expect(await resolveUserId(bindings, '000000000000000000000002')).toBe('2');
		expect(await resolveUserId(bindings, '42')).toBe('42');
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('resolves a uuid through mantle2 and caches the answer forever', async () => {
		const bindings = createMockBindings();
		mantleReplies({ id: '000000000000000000000007' });

		expect(await resolveUserId(bindings, HEX)).toBe('7');
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(await bindings.KV.get(`user:alias:${HEX}`)).toBe('7');

		// second call is answered from kv
		expect(await resolveUserId(bindings, HEX)).toBe('7');
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it('asks mantle2 with the admin key, never anonymously', async () => {
		const bindings = createMockBindings();
		mantleReplies({ id: '7' });

		await resolveUserId(bindings, HEX);

		const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(url).toContain(`/v2/admin/users/${HEX}/internal_id`);
		expect((init.headers as Record<string, string>).Authorization).toMatch(/^Bearer .+/);
	});

	it('accepts a numeric id sent back as a number', async () => {
		const bindings = createMockBindings();
		mantleReplies({ id: 7 });
		expect(await resolveUserId(bindings, HEX)).toBe('7');
	});

	it('returns null for a uuid mantle2 does not know, and caches nothing', async () => {
		const bindings = createMockBindings();
		mantleReplies({}, false);

		expect(await resolveUserId(bindings, HEX)).toBeNull();
		expect(await bindings.KV.get(`user:alias:${HEX}`)).toBeNull();
	});

	it('returns null rather than throwing when mantle2 is unreachable', async () => {
		const bindings = createMockBindings();
		fetchSpy.mockRejectedValue(new Error('network down'));

		expect(await resolveUserId(bindings, HEX)).toBeNull();
	});

	it('refuses a nonsense answer instead of keying kv on it', async () => {
		const bindings = createMockBindings();
		mantleReplies({ id: 'not-numeric' });

		expect(await resolveUserId(bindings, HEX)).toBeNull();
		expect(await bindings.KV.get(`user:alias:${HEX}`)).toBeNull();
	});

	it('ignores a poisoned cache entry and re-resolves', async () => {
		const bindings = createMockBindings();
		await bindings.KV.put(`user:alias:${HEX}`, 'garbage');
		mantleReplies({ id: '9' });

		expect(await resolveUserId(bindings, HEX)).toBe('9');
	});

	it('rejects a shape it does not recognise without calling mantle2', async () => {
		const bindings = createMockBindings();

		expect(await resolveUserId(bindings, 'a1b2c3d4-e5f6-0718-293a-4b5c6d7e8f90')).toBeNull();
		expect(await resolveUserId(bindings, '')).toBeNull();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	// the contract: both forms land on the same data
	it('lands both shapes of one account on the same canonical id', async () => {
		const bindings = createMockBindings();
		mantleReplies({ id: '2' });

		const viaUuid = await resolveUserId(bindings, HEX);
		const viaNumeric = await resolveUserId(bindings, '000000000000000000000002');
		expect(viaUuid).toBe(viaNumeric);
	});
});

describe('rememberUserAlias', () => {
	it('records a pair so the first request never pays for a lookup', async () => {
		const bindings = createMockBindings();

		expect(await rememberUserAlias(bindings, HEX, '000000000000000000000005')).toBe(true);
		expect(await resolveUserId(bindings, HEX)).toBe('5');
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('refuses a bad uuid or a non-numeric id', async () => {
		const bindings = createMockBindings();

		expect(await rememberUserAlias(bindings, 'nope', '5')).toBe(false);
		expect(await rememberUserAlias(bindings, HEX, 'nope')).toBe(false);
		expect(await bindings.KV.get(`user:alias:${HEX}`)).toBeNull();
	});
});

describe('resolveEntityId for content', () => {
	it('asks the shared content route, one keyspace per kind', async () => {
		const bindings = createMockBindings();
		mantleReplies({ id: '31' });

		expect(await resolveEntityId(bindings, 'article', HEX)).toBe('31');

		const [url] = fetchSpy.mock.calls[0] as [string];
		expect(url).toContain(`/v2/admin/article/${HEX}/internal_id`);
		expect(await bindings.KV.get(`article:alias:${HEX}`)).toBe('31');
		// the user keyspace is separate, so an article and a user cannot collide on one uuid
		expect(await bindings.KV.get(`user:alias:${HEX}`)).toBeNull();
	});

	it('canonicalises a numeric content id with no round trip', async () => {
		const bindings = createMockBindings();

		expect(await resolveEntityId(bindings, 'event', '000000000000000000000009')).toBe('9');
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('returns null for a uuid mantle2 does not know', async () => {
		const bindings = createMockBindings();
		mantleReplies('Not found', false);

		expect(await resolveEntityId(bindings, 'prompt', HEX)).toBeNull();
		expect(await bindings.KV.get(`prompt:alias:${HEX}`)).toBeNull();
	});

	it('rejects a shape that is neither', async () => {
		const bindings = createMockBindings();

		expect(await resolveEntityId(bindings, 'article', 'not-an-id')).toBeNull();
		expect(await resolveEntityId(bindings, 'article', '')).toBeNull();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('keeps resolveUserId on the users path', async () => {
		const bindings = createMockBindings();
		mantleReplies({ id: '7' });

		await resolveUserId(bindings, HEX);

		const [url] = fetchSpy.mock.calls[0] as [string];
		expect(url).toContain(`/v2/admin/users/${HEX}/internal_id`);
	});
});
