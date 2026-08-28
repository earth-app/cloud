import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	decideOutdoorNudge,
	markOutdoorNudged,
	OUTDOOR_ALREADY_OUT_MINUTES,
	OUTDOOR_DECAY_DAYS,
	OUTDOOR_QUIET_HOURS,
	shouldNudgeOutdoors
} from '../../src/user/outdoor';
import { judgeConditions, MAX_PRECIPITATION_MM } from '../../src/util/weather';
import { createMockBindings } from '../helpers/mock-bindings';
import type { Bindings } from '../../src/util/types';

const UID = '42';
const DAY_MS = 24 * 60 * 60 * 1000;

function base(overrides: Partial<Parameters<typeof decideOutdoorNudge>[0]> = {}) {
	return {
		minutesToday: 0,
		minutesInWindow: 30,
		hoursSinceNudge: null,
		weatherOk: true,
		...overrides
	};
}

// credits `minutes` into this week's ledger at `at`
async function credit(bindings: Bindings, minutes: number, at: number) {
	const d = new Date(at);
	const year = d.getUTCFullYear();
	const yearStart = new Date(Date.UTC(year, 0, 1));
	const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
	const key = `nature_minutes:${UID}:${year}-W${String(week).padStart(2, '0')}`;
	const existing = (await bindings.KV.get<{ sources: unknown[] }>(key, 'json')) ?? { sources: [] };
	await bindings.KV.put(
		key,
		JSON.stringify({
			...existing,
			sources: [
				...existing.sources,
				{ kind: 'trail', minutes, at: new Date(at).toISOString(), ref_id: 'x' }
			]
		})
	);
}

beforeEach(() => {
	vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('decideOutdoorNudge', () => {
	it('sends when nothing is in the way', () => {
		expect(decideOutdoorNudge(base())).toMatchObject({ send: true, reason: 'send' });
	});

	it('stays quiet once the user has already been out today', () => {
		expect(decideOutdoorNudge(base({ minutesToday: OUTDOOR_ALREADY_OUT_MINUTES }))).toMatchObject({
			send: false,
			reason: 'already_out_today'
		});
		// a minute short of the threshold is not "been out"
		expect(decideOutdoorNudge(base({ minutesToday: OUTDOOR_ALREADY_OUT_MINUTES - 1 })).send).toBe(
			true
		);
	});

	it('sends at most one nudge a day', () => {
		expect(decideOutdoorNudge(base({ hoursSinceNudge: 0 })).reason).toBe('nudged_recently');
		expect(decideOutdoorNudge(base({ hoursSinceNudge: OUTDOOR_QUIET_HOURS - 0.1 })).send).toBe(
			false
		);
		expect(decideOutdoorNudge(base({ hoursSinceNudge: OUTDOOR_QUIET_HOURS })).send).toBe(true);
	});

	it('stops after a fortnight with no credited minute', () => {
		expect(decideOutdoorNudge(base({ minutesInWindow: 0 })).reason).toBe(
			'no_outcome_in_a_fortnight'
		);
		// and returns the moment any minutes land
		expect(decideOutdoorNudge(base({ minutesInWindow: 1 })).send).toBe(true);
	});

	it('does not tell anyone to go out in the rain', () => {
		expect(
			decideOutdoorNudge(base({ weatherOk: false, weatherReason: 'precipitation' }))
		).toMatchObject({ send: false, reason: 'weather', weather: 'precipitation' });
	});

	// order matters: redundancy and pacing are cheaper checks than a forecast
	it('reports redundancy before pacing, and pacing before weather', () => {
		expect(
			decideOutdoorNudge(base({ minutesToday: 30, hoursSinceNudge: 0, weatherOk: false })).reason
		).toBe('already_out_today');
		expect(decideOutdoorNudge(base({ hoursSinceNudge: 0, weatherOk: false })).reason).toBe(
			'nudged_recently'
		);
	});
});

describe('weather thresholds', () => {
	it('treats unknown conditions as no obstacle', () => {
		expect(judgeConditions(undefined, undefined)).toMatchObject({ ok: true, reason: 'unknown' });
		expect(judgeConditions(0, undefined).ok).toBe(true);
	});

	it('blocks on precipitation over the threshold only', () => {
		expect(judgeConditions(MAX_PRECIPITATION_MM, 12).ok).toBe(true);
		expect(judgeConditions(MAX_PRECIPITATION_MM + 0.1, 12)).toMatchObject({
			ok: false,
			reason: 'precipitation'
		});
	});

	it('blocks on temperature at either extreme', () => {
		expect(judgeConditions(0, -6).reason).toBe('temperature');
		expect(judgeConditions(0, 36).reason).toBe('temperature');
		expect(judgeConditions(0, 18).reason).toBe('clear');
	});
});

describe('shouldNudgeOutdoors', () => {
	it('sends for an account with recent minutes but none today', async () => {
		const bindings = createMockBindings();
		await credit(bindings, 20, Date.now() - 3 * DAY_MS);

		expect(await shouldNudgeOutdoors(bindings, UID)).toMatchObject({ send: true });
	});

	it('stays quiet for an account that went out today', async () => {
		const bindings = createMockBindings();
		await credit(bindings, 20, Date.now() - 2 * DAY_MS);
		await credit(bindings, 10, Date.now());

		expect((await shouldNudgeOutdoors(bindings, UID)).reason).toBe('already_out_today');
	});

	it('stays quiet for an account with nothing in the window', async () => {
		const bindings = createMockBindings();
		expect((await shouldNudgeOutdoors(bindings, UID)).reason).toBe('no_outcome_in_a_fortnight');
	});

	it('honours the stamp written by markOutdoorNudged', async () => {
		const bindings = createMockBindings();
		await credit(bindings, 20, Date.now() - 3 * DAY_MS);
		await markOutdoorNudged(bindings, UID);

		expect((await shouldNudgeOutdoors(bindings, UID)).reason).toBe('nudged_recently');
	});

	it('normalises a padded id onto the same stamp', async () => {
		const bindings = createMockBindings();
		await markOutdoorNudged(bindings, '000000000000000000000042');
		expect(await bindings.KV.get('outdoor:nudged:42')).not.toBeNull();
	});

	// the point of putting the decision here: it can read the weather, which a pre-scheduled local
	// notification cannot
	it('asks for a forecast only once the cheap gates have passed', async () => {
		const bindings = createMockBindings();
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({
				properties: {
					timeseries: [
						{
							data: {
								instant: { details: { air_temperature: 14 } },
								next_1_hours: { details: { precipitation_amount: 0 } }
							}
						}
					]
				}
			})
		} as unknown as Response);

		// nothing in the window: the gate fails before any network call
		await shouldNudgeOutdoors(bindings, UID, { lat: 59.91, lon: 10.75 });
		expect(fetchSpy).not.toHaveBeenCalled();

		await credit(bindings, 20, Date.now() - 3 * DAY_MS);
		expect(await shouldNudgeOutdoors(bindings, UID, { lat: 59.91, lon: 10.75 })).toMatchObject({
			send: true,
			weather: 'clear'
		});
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it('blocks the nudge when the forecast says rain', async () => {
		const bindings = createMockBindings();
		await credit(bindings, 20, Date.now() - 3 * DAY_MS);
		vi.spyOn(globalThis, 'fetch').mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({
				properties: {
					timeseries: [
						{
							data: {
								instant: { details: { air_temperature: 9 } },
								next_1_hours: { details: { precipitation_amount: 1.4 } }
							}
						}
					]
				}
			})
		} as unknown as Response);

		expect(await shouldNudgeOutdoors(bindings, UID, { lat: 59.91, lon: 10.75 })).toMatchObject({
			send: false,
			reason: 'weather',
			weather: 'precipitation'
		});
	});

	it('still sends when the forecast is unreachable, and when there are no coordinates', async () => {
		const bindings = createMockBindings();
		await credit(bindings, 20, Date.now() - 3 * DAY_MS);
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('down'));

		expect((await shouldNudgeOutdoors(bindings, UID, { lat: 59.91, lon: 10.75 })).send).toBe(true);

		fetchSpy.mockClear();
		expect((await shouldNudgeOutdoors(bindings, UID)).send).toBe(true);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('skips the forecast for nonsense coordinates rather than sending them upstream', async () => {
		const bindings = createMockBindings();
		await credit(bindings, 20, Date.now() - 3 * DAY_MS);
		const fetchSpy = vi.spyOn(globalThis, 'fetch');

		expect((await shouldNudgeOutdoors(bindings, UID, { lat: 999, lon: 10 })).send).toBe(true);
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
