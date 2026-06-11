import { Bindings, ExecutionCtxLike } from '../util/types';
import { normalizeId } from '../util/util';
import { addImpactPoints } from './points';
import { addBadgeProgress, checkAndGrantBadges } from './badges';
import { sendUserNotification } from './notifications';

// Crockford base32, no ambiguous chars (I/L/O/U)
const REFERRAL_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const REFERRAL_CODE_LENGTH = 6;
export const REFERRER_POINTS = 50;
export const REFEREE_POINTS = 25;

export type ReferralRecord = {
	user_id: string;
	created_at: number;
	clicks: number;
};

export type ReferralStats = {
	code: string;
	clicks: number;
	conversions: number;
	converted_ids: string[];
};

export type ConversionResult = {
	ok: boolean;
	reason?: 'invalid_code' | 'self_referral' | 'already_attributed';
	referrer_id?: string;
};

function codeKey(code: string) {
	return `referral:code:${code.toUpperCase()}`;
}
function conversionsKey(userId: string) {
	return `referral:conversions:${normalizeId(userId)}`;
}
function attributedKey(newUserId: string) {
	return `referral:attributed:${normalizeId(newUserId)}`;
}

// 256 is a multiple of 32 so the modulo is unbiased
function generateCode(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(REFERRAL_CODE_LENGTH));
	let code = '';
	for (const byte of bytes) {
		code += REFERRAL_ALPHABET[byte % REFERRAL_ALPHABET.length];
	}
	return code;
}

function parseStringArray(raw: string | null): string[] {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

export async function createOrGetCode(env: Bindings, userId: string): Promise<string> {
	const normalizedId = normalizeId(userId);
	const existing = await env.KV.get(`referral:user:${normalizedId}`);
	if (existing) return existing;

	// retry on the rare collision
	let code = generateCode();
	for (let i = 0; i < 5; i++) {
		const taken = await env.KV.get(codeKey(code));
		if (!taken) break;
		code = generateCode();
	}

	const record: ReferralRecord = { user_id: normalizedId, created_at: Date.now(), clicks: 0 };
	await env.KV.put(codeKey(code), JSON.stringify(record), { metadata: { user_id: normalizedId } });
	await env.KV.put(`referral:user:${normalizedId}`, code);
	return code;
}

export async function getByCode(env: Bindings, code: string): Promise<ReferralRecord | null> {
	const raw = await env.KV.get(codeKey(code));
	if (!raw) return null;
	try {
		return JSON.parse(raw) as ReferralRecord;
	} catch {
		return null;
	}
}

export async function recordClick(env: Bindings, code: string): Promise<void> {
	const record = await getByCode(env, code);
	if (!record) return;
	record.clicks++;
	await env.KV.put(codeKey(code), JSON.stringify(record), {
		metadata: { user_id: record.user_id }
	});
}

export async function getStats(env: Bindings, userId: string): Promise<ReferralStats> {
	const code = await createOrGetCode(env, userId);
	const record = await getByCode(env, code);
	const convertedIds = parseStringArray(await env.KV.get(conversionsKey(userId)));

	return {
		code,
		clicks: record?.clicks || 0,
		conversions: convertedIds.length,
		converted_ids: convertedIds
	};
}

// validates the code, awards both parties, and progresses the recruiter tracker
export async function recordConversion(
	env: Bindings,
	code: string,
	newUserId: string,
	ctx: ExecutionCtxLike
): Promise<ConversionResult> {
	const record = await getByCode(env, code);
	if (!record) return { ok: false, reason: 'invalid_code' };

	const referrerId = record.user_id;
	const refereeId = normalizeId(newUserId);

	if (referrerId === refereeId) return { ok: false, reason: 'self_referral' };

	// one attribution per user, ever; written before awards so a retry can't double-pay
	const attributed = await env.KV.get(attributedKey(refereeId));
	if (attributed) return { ok: false, reason: 'already_attributed' };
	await env.KV.put(attributedKey(refereeId), code.toUpperCase());

	const convertedIds = parseStringArray(await env.KV.get(conversionsKey(referrerId)));
	if (!convertedIds.includes(refereeId)) {
		convertedIds.push(refereeId);
		await env.KV.put(conversionsKey(referrerId), JSON.stringify(convertedIds));
	}

	await addImpactPoints(referrerId, REFERRER_POINTS, 'Referral: a friend joined', env.KV);
	await addImpactPoints(refereeId, REFEREE_POINTS, 'Welcome bonus (joined via referral)', env.KV);
	await addBadgeProgress(referrerId, 'referrals_converted', refereeId, env.KV);

	ctx.waitUntil(checkAndGrantBadges(referrerId, 'referrals_converted', env, ctx));
	ctx.waitUntil(
		sendUserNotification(
			env,
			referrerId,
			'Your Invite Worked!',
			'A friend joined The Earth App with your invite. You both earned impact points!',
			undefined,
			'success'
		)
	);

	return { ok: true, referrer_id: referrerId };
}
