import { Bindings, ExecutionCtxLike } from '../util/types';
import { normalizeId } from '../util/util';
import { sendUserNotification } from './notifications';

export type ChallengeStatus = 'pending' | 'active' | 'declined' | 'completed' | 'expired';

export type Challenge = {
	id: string;
	quest_id: string;
	quest_title: string;
	challenger_id: string;
	challenger_name: string;
	recipient_id: string;
	recipient_name: string;
	status: ChallengeStatus;
	created_at: number;
	accepted_at?: number;
};

export type CreateChallengeInput = {
	quest_id: string;
	quest_title: string;
	challenger_id: string;
	challenger_name: string;
	recipient_id: string;
	recipient_name: string;
};

const CHALLENGE_TTL = 60 * 60 * 24 * 30; // 30 days

const idKey = (id: string) => `challenge:${id}`;
const activeKey = (userId: string, questId: string) =>
	`challenge:active:${normalizeId(userId)}:${questId}`;
const userListKey = (userId: string) => `challenge:user:${normalizeId(userId)}`;
const pairKey = (challengerId: string, recipientId: string, questId: string) =>
	`challenge:pair:${normalizeId(challengerId)}:${normalizeId(recipientId)}:${questId}`;
// per-user "pending challenge on this quest" lookup so the quest-modal banner can offer
// Accept/Decline (recipient) or a waiting state (challenger) before it goes active
const pendingKey = (userId: string, questId: string) =>
	`challenge:pending:${normalizeId(userId)}:${questId}`;

function genId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(8));
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

async function readChallenge(env: Bindings, id: string): Promise<Challenge | null> {
	const raw = await env.KV.get(idKey(id));
	if (!raw) return null;
	try {
		return JSON.parse(raw) as Challenge;
	} catch {
		return null;
	}
}

async function writeChallenge(env: Bindings, challenge: Challenge): Promise<void> {
	await env.KV.put(idKey(challenge.id), JSON.stringify(challenge), {
		expirationTtl: CHALLENGE_TTL
	});
}

async function addToUserList(env: Bindings, userId: string, id: string): Promise<void> {
	const key = userListKey(userId);
	const raw = await env.KV.get(key);
	let list: string[] = [];
	if (raw) {
		try {
			const parsed = JSON.parse(raw);
			if (Array.isArray(parsed)) list = parsed;
		} catch {
			list = [];
		}
	}
	if (!list.includes(id)) {
		list.unshift(id);
		await env.KV.put(key, JSON.stringify(list.slice(0, 50)), { expirationTtl: CHALLENGE_TTL });
	}
}

export async function getChallenge(env: Bindings, id: string): Promise<Challenge | null> {
	return readChallenge(env, id);
}

export async function createChallenge(
	env: Bindings,
	input: CreateChallengeInput
): Promise<Challenge> {
	const challengerId = normalizeId(input.challenger_id);
	const recipientId = normalizeId(input.recipient_id);

	// reuse an existing open challenge for the same pairing + quest
	const existingId = await env.KV.get(pairKey(challengerId, recipientId, input.quest_id));
	if (existingId) {
		const existing = await readChallenge(env, existingId);
		if (existing && (existing.status === 'pending' || existing.status === 'active')) {
			return existing;
		}
	}

	const challenge: Challenge = {
		id: genId(),
		quest_id: input.quest_id,
		quest_title: input.quest_title,
		challenger_id: challengerId,
		challenger_name: input.challenger_name,
		recipient_id: recipientId,
		recipient_name: input.recipient_name,
		status: 'pending',
		created_at: Date.now()
	};

	await writeChallenge(env, challenge);
	await env.KV.put(pairKey(challengerId, recipientId, input.quest_id), challenge.id, {
		expirationTtl: CHALLENGE_TTL
	});
	await Promise.all([
		addToUserList(env, challengerId, challenge.id),
		addToUserList(env, recipientId, challenge.id),
		env.KV.put(pendingKey(challengerId, input.quest_id), challenge.id, {
			expirationTtl: CHALLENGE_TTL
		}),
		env.KV.put(pendingKey(recipientId, input.quest_id), challenge.id, {
			expirationTtl: CHALLENGE_TTL
		})
	]);

	return challenge;
}

export type ChallengeActionResult = {
	ok: boolean;
	reason?: 'not_found' | 'forbidden' | 'bad_status';
	challenge?: Challenge;
};

export async function acceptChallenge(
	env: Bindings,
	id: string,
	userId: string,
	ctx: ExecutionCtxLike
): Promise<ChallengeActionResult> {
	const challenge = await readChallenge(env, id);
	if (!challenge) return { ok: false, reason: 'not_found' };
	// only the recipient can accept
	if (normalizeId(userId) !== challenge.recipient_id) return { ok: false, reason: 'forbidden' };
	if (challenge.status !== 'pending') return { ok: false, reason: 'bad_status' };

	challenge.status = 'active';
	challenge.accepted_at = Date.now();
	await writeChallenge(env, challenge);
	// O(1) active lookup for both sides (used by the quest-modal banner + the step hook)
	await Promise.all([
		env.KV.put(activeKey(challenge.challenger_id, challenge.quest_id), challenge.id, {
			expirationTtl: CHALLENGE_TTL
		}),
		env.KV.put(activeKey(challenge.recipient_id, challenge.quest_id), challenge.id, {
			expirationTtl: CHALLENGE_TTL
		}),
		env.KV.delete(pendingKey(challenge.challenger_id, challenge.quest_id)),
		env.KV.delete(pendingKey(challenge.recipient_id, challenge.quest_id))
	]);

	// let the challenger know it's game on
	ctx.waitUntil(
		sendUserNotification(
			env,
			challenge.challenger_id,
			'Challenge Accepted!',
			`${challenge.recipient_name} accepted your "${challenge.quest_title}" challenge. Game on!`,
			`/profile/quests?open=${challenge.quest_id}`,
			'success',
			`@${challenge.recipient_name}`
		)
	);

	return { ok: true, challenge };
}

export async function declineChallenge(
	env: Bindings,
	id: string,
	userId: string,
	ctx: ExecutionCtxLike
): Promise<ChallengeActionResult> {
	const challenge = await readChallenge(env, id);
	if (!challenge) return { ok: false, reason: 'not_found' };
	if (normalizeId(userId) !== challenge.recipient_id) return { ok: false, reason: 'forbidden' };
	if (challenge.status !== 'pending') return { ok: false, reason: 'bad_status' };

	challenge.status = 'declined';
	await writeChallenge(env, challenge);
	await Promise.all([
		env.KV.delete(pairKey(challenge.challenger_id, challenge.recipient_id, challenge.quest_id)),
		env.KV.delete(pendingKey(challenge.challenger_id, challenge.quest_id)),
		env.KV.delete(pendingKey(challenge.recipient_id, challenge.quest_id))
	]);

	ctx.waitUntil(
		sendUserNotification(
			env,
			challenge.challenger_id,
			'Challenge Declined',
			`${challenge.recipient_name} isn't up for the "${challenge.quest_title}" challenge right now.`,
			undefined,
			'info',
			`@${challenge.recipient_name}`
		)
	);

	return { ok: true, challenge };
}

// the active challenge for a user on a given quest (active or just-completed), or null
export async function getActiveChallengeFor(
	env: Bindings,
	userId: string,
	questId: string
): Promise<Challenge | null> {
	const id = await env.KV.get(activeKey(userId, questId));
	if (!id) return null;
	const challenge = await readChallenge(env, id);
	if (!challenge) return null;
	if (challenge.status !== 'active' && challenge.status !== 'completed') return null;
	return challenge;
}

// the challenge to surface in the quest modal for this user+quest: an active/completed one
// if present, otherwise a still-pending one (so the recipient can Accept/Decline). null when
// there's nothing actionable.
export async function getChallengeFor(
	env: Bindings,
	userId: string,
	questId: string
): Promise<Challenge | null> {
	const active = await getActiveChallengeFor(env, userId, questId);
	if (active) return active;
	const pendingId = await env.KV.get(pendingKey(userId, questId));
	if (!pendingId) return null;
	const pending = await readChallenge(env, pendingId);
	return pending && pending.status === 'pending' ? pending : null;
}

export async function listChallengesForUser(env: Bindings, userId: string): Promise<Challenge[]> {
	const raw = await env.KV.get(userListKey(userId));
	if (!raw) return [];
	let ids: string[] = [];
	try {
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed)) ids = parsed;
	} catch {
		return [];
	}
	const challenges = await Promise.all(ids.map((id) => readChallenge(env, id)));
	return challenges.filter((c): c is Challenge => c !== null);
}

export async function notifyChallengeStep(
	env: Bindings,
	completerId: string,
	questId: string,
	stepIndex: number,
	completed: boolean,
	ctx: ExecutionCtxLike
): Promise<void> {
	const challenge = await getActiveChallengeFor(env, completerId, questId);
	if (!challenge) return;

	const completerIsChallenger = normalizeId(completerId) === challenge.challenger_id;
	const otherId = completerIsChallenger ? challenge.recipient_id : challenge.challenger_id;
	const completerName = completerIsChallenger
		? challenge.challenger_name
		: challenge.recipient_name;

	if (completed) {
		// mark the challenge complete
		challenge.status = 'completed';
		await writeChallenge(env, challenge);
		ctx.waitUntil(
			sendUserNotification(
				env,
				otherId,
				'Challenge Finished!',
				`${completerName} just finished the "${challenge.quest_title}" challenge. Catch up!`,
				`/profile/quests?open=${challenge.quest_id}`,
				'success',
				`@${completerName}`
			)
		);
		return;
	}

	ctx.waitUntil(
		sendUserNotification(
			env,
			otherId,
			'Challenge Update',
			`${completerName} completed step ${stepIndex + 1} of the "${challenge.quest_title}" challenge.`,
			`/profile/quests?open=${challenge.quest_id}`,
			'info',
			`@${completerName}`
		)
	);
}
