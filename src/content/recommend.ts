import { isActivityType, type ActivityType } from '../util/enums';

// #region types

/** The shape mantle2 posts. `type` is ocean's polymorphic discriminator; accepted, unused. */
export type RecommendActivity = {
	type?: string;
	id: string;
	name: string;
	description?: string | null;
	aliases?: string[];
	activity_types?: ActivityType[];
};

type Scored = {
	activity: RecommendActivity;
	keywordScore: number;
	typeScore: number;
	totalScore: number;
	isNovel: boolean;
};

// #endregion

// #region scoring

const WORD_SPLIT = /\W+/;

/**
 * Tokens of length > 2, lowercased, from the name and description.
 *
 * @param activity candidate or current activity
 */
function keywordSet(activity: RecommendActivity): Set<string> {
	const out = new Set<string>();
	const add = (text: string) => {
		for (const token of text.split(WORD_SPLIT)) {
			if (token.length > 2) out.add(token.toLowerCase());
		}
	};

	add(activity.name ?? '');
	add(activity.description ?? '');
	return out;
}

function typesOf(activity: RecommendActivity): ActivityType[] {
	return (activity.activity_types ?? []).filter(isActivityType);
}

// #endregion

// #region validation

/**
 * Accept only what the algorithm can actually score.
 *
 * ocean ran this through `Exportable.fromJson`, which THREW on a malformed entry and took the whole
 * request with it. Dropping the bad entry instead keeps a recommendation coming back when mantle2
 * sends one dud row in a batch of hundreds.
 *
 * @param value one element of the posted array
 */
export function isRecommendActivity(value: unknown): value is RecommendActivity {
	if (!value || typeof value !== 'object') return false;

	const a = value as Record<string, unknown>;
	if (typeof a.id !== 'string' || !a.id) return false;
	if (typeof a.name !== 'string' || !a.name) return false;
	if (a.description != null && typeof a.description !== 'string') return false;
	if (a.aliases != null && !Array.isArray(a.aliases)) return false;
	if (a.activity_types != null && !Array.isArray(a.activity_types)) return false;

	return true;
}

/**
 * Keep the valid entries of a posted array.
 *
 * @param value the raw `all` or `user` array
 */
export function parseActivities(value: unknown): RecommendActivity[] {
	return Array.isArray(value) ? value.filter(isRecommendActivity) : [];
}

// #endregion

// #region recommendation

/**
 * Recommend up to three activities from `all`, given what the user already does.
 *
 * - the first is the closest match to the user's current activities
 * - the second is related-but-different (a tie-break between similarity and novelty)
 * - the third is intentionally different, for a fresh experience
 *
 * @param all every activity in the system
 * @param current the activities the user is already engaged in
 */
export function recommendActivity(
	all: RecommendActivity[],
	current: RecommendActivity[]
): RecommendActivity[] {
	const currentIds = new Set(current.map((a) => a.id));

	const currentKeywords = new Set<string>();
	const currentTypes = new Set<ActivityType>();
	for (const activity of current) {
		for (const k of keywordSet(activity)) currentKeywords.add(k);
		for (const t of typesOf(activity)) currentTypes.add(t);
	}
	const currentTypesSize = Math.max(currentTypes.size, 1);

	const scored: Scored[] = [];
	for (const activity of all) {
		if (currentIds.has(activity.id)) continue;

		const candidateKeywords = keywordSet(activity);

		let intersection = 0;
		for (const k of candidateKeywords) if (currentKeywords.has(k)) intersection++;
		const union = Math.max(currentKeywords.size + candidateKeywords.size - intersection, 1);
		const keywordScore = intersection / union;

		let sharedTypes = 0;
		for (const t of typesOf(activity)) if (currentTypes.has(t)) sharedTypes++;
		const typeScore = sharedTypes / currentTypesSize;

		scored.push({
			activity,
			keywordScore,
			typeScore,
			totalScore: keywordScore * 0.6 + typeScore * 0.4,
			isNovel: keywordScore === 0 && typeScore === 0
		});
	}

	// score desc, then prefer a novel candidate on a tie
	const sorted = [...scored].sort(
		(a, b) => b.totalScore - a.totalScore || Number(b.isNovel) - Number(a.isNovel)
	);

	const first = sorted[0]?.activity;
	const second =
		sorted.length >= 3
			? sorted[Math.floor(sorted.length / 2)]?.activity
			: sorted.length === 2
				? sorted[1]?.activity
				: undefined;

	/* deliberately drawn from `scored`, NOT `sorted`: the kotlin fell back to the last element in
	   INSERTION order, so keeping the unsorted list preserves which activity that is */
	const distant = scored.filter((s) => s.keywordScore < 0.2 && s.typeScore < 0.2);
	const different =
		distant.length > 0
			? distant[Math.floor(Math.random() * distant.length)]?.activity
			: scored[scored.length - 1]?.activity;

	return [first, second, different].filter((a): a is RecommendActivity => a !== undefined);
}

// #endregion
