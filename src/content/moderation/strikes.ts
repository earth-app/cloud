import { Bindings } from '../../util/types';
import { ReportableContentType, ReportReason, ReportSource } from '../reports';

export type StrikeHistoryEntry = {
	content_type: ReportableContentType;
	content_id: string;
	reason: ReportReason;
	source: ReportSource;
	at: number;
	report_id?: string; // links to the ContentReport that triggered this strike
	action_notes?: string; // moderator note / ai label summary explaining the removal
	preview?: string; // short snippet of the removed content, captured at removal time
};

export type UserStrikes = {
	count: number; // 0..3 within the current cycle
	cycles: number;
	history: StrikeHistoryEntry[];
	disabled_until?: number; // epoch ms
	banned: boolean;
	updated_at: number;
};

export type StrikeAction = 'none' | 'disable_1_month' | 'permanent_ban';

const KEY = (userId: string) => `user:strikes:${userId}`;
const STRIKE_THRESHOLD = 3;
const BAN_CYCLE_THRESHOLD = 2;
const ONE_MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const HISTORY_CAP = 100;

function zeroed(): UserStrikes {
	return { count: 0, cycles: 0, history: [], banned: false, updated_at: Date.now() };
}

export async function getStrikes(env: Bindings, userId: string): Promise<UserStrikes> {
	const stored = await env.KV.get<UserStrikes>(KEY(userId), 'json');
	if (!stored) return zeroed();
	return {
		count: stored.count ?? 0,
		cycles: stored.cycles ?? 0,
		history: Array.isArray(stored.history) ? stored.history : [],
		disabled_until: stored.disabled_until,
		banned: stored.banned ?? false,
		updated_at: stored.updated_at ?? Date.now()
	};
}

// record a server-side removal and compute the enforcement action.
// count reaches 3 => disable_1_month, then reset count + cycles++. cycles reaching 2 => permanent_ban.
export async function addStrike(
	env: Bindings,
	userId: string,
	entry: Omit<StrikeHistoryEntry, 'at'>
): Promise<{ strikes: UserStrikes; action: StrikeAction }> {
	const strikes = await getStrikes(env, userId);
	const now = Date.now();

	strikes.history.push({ ...entry, at: now });
	if (strikes.history.length > HISTORY_CAP) {
		strikes.history = strikes.history.slice(-HISTORY_CAP);
	}
	strikes.count += 1;
	strikes.updated_at = now;

	let action: StrikeAction = 'none';

	if (strikes.count >= STRIKE_THRESHOLD) {
		strikes.count = 0;
		strikes.cycles += 1;

		if (strikes.cycles >= BAN_CYCLE_THRESHOLD) {
			strikes.banned = true;
			action = 'permanent_ban';
		} else {
			strikes.disabled_until = now + ONE_MONTH_MS;
			action = 'disable_1_month';
		}
	}

	await env.KV.put(KEY(userId), JSON.stringify(strikes));
	return { strikes, action };
}

export async function resetStrikes(env: Bindings, userId: string): Promise<UserStrikes> {
	const fresh = zeroed();
	await env.KV.put(KEY(userId), JSON.stringify(fresh));
	return fresh;
}

export async function deleteStrikes(env: Bindings, userId: string): Promise<void> {
	await env.KV.delete(KEY(userId));
}
