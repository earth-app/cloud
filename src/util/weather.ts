import { Bindings } from './types';

// met.no's terms require the attribution and an identifying user-agent, and they block a generic
// one, so USER_AGENT is not optional
const FORECAST_URL = 'https://api.met.no/weatherapi/locationforecast/2.0/compact';
const USER_AGENT = 'EarthApp/1.0 (https://earth-app.com; support@earth-app.com)';

// met.no asks callers to truncate coordinates to 4 decimals; doing it here also makes the cache key
// coarse enough that neighbours share an entry
const COORD_PRECISION = 2;
const CACHE_TTL = 60 * 30;

export const MAX_PRECIPITATION_MM = 0.2;
export const MIN_TEMPERATURE_C = -5;
export const MAX_TEMPERATURE_C = 35;

export type OutdoorWindow = {
	ok: boolean;
	reason: 'clear' | 'precipitation' | 'temperature' | 'unknown';
	precipitation?: number;
	temperature?: number;
};

const cacheKey = (lat: number, lon: number) =>
	`weather:${lat.toFixed(COORD_PRECISION)}:${lon.toFixed(COORD_PRECISION)}`;

export function judgeConditions(
	precipitation: number | undefined,
	temperature: number | undefined
): OutdoorWindow {
	if (typeof precipitation !== 'number' || typeof temperature !== 'number') {
		// unknown weather never blocks a nudge; the gate fails open
		return { ok: true, reason: 'unknown' };
	}

	if (precipitation > MAX_PRECIPITATION_MM) {
		return { ok: false, reason: 'precipitation', precipitation, temperature };
	}

	if (temperature < MIN_TEMPERATURE_C || temperature > MAX_TEMPERATURE_C) {
		return { ok: false, reason: 'temperature', precipitation, temperature };
	}

	return { ok: true, reason: 'clear', precipitation, temperature };
}

type Forecast = {
	properties?: {
		timeseries?: {
			data?: {
				instant?: { details?: { air_temperature?: number } };
				next_1_hours?: { details?: { precipitation_amount?: number } };
			};
		}[];
	};
};

export function readFirstHour(forecast: Forecast): {
	precipitation?: number;
	temperature?: number;
} {
	const first = forecast?.properties?.timeseries?.[0]?.data;
	return {
		temperature: first?.instant?.details?.air_temperature,
		precipitation: first?.next_1_hours?.details?.precipitation_amount
	};
}

// fails open on every error path: a nudge in light rain beats an outage silencing every nudge
export async function getOutdoorWindow(
	env: Bindings,
	lat: number,
	lon: number
): Promise<OutdoorWindow> {
	if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { ok: true, reason: 'unknown' };
	if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return { ok: true, reason: 'unknown' };

	const key = cacheKey(lat, lon);
	const cached = await env.CACHE.get<OutdoorWindow>(key, 'json').catch(() => null);
	if (cached && typeof cached.ok === 'boolean') return cached;

	try {
		const url = `${FORECAST_URL}?lat=${lat.toFixed(COORD_PRECISION)}&lon=${lon.toFixed(COORD_PRECISION)}`;
		const res = await fetch(url, {
			headers: { Accept: 'application/json', 'User-Agent': USER_AGENT }
		});
		if (!res.ok) {
			console.warn('[weather] non-success forecast response', { status: res.status });
			return { ok: true, reason: 'unknown' };
		}

		const { precipitation, temperature } = readFirstHour((await res.json()) as Forecast);
		const window = judgeConditions(precipitation, temperature);
		await env.CACHE.put(key, JSON.stringify(window), { expirationTtl: CACHE_TTL });
		return window;
	} catch (err) {
		console.error('[weather] forecast lookup failed', {
			error: err instanceof Error ? err.message : String(err)
		});
		return { ok: true, reason: 'unknown' };
	}
}
