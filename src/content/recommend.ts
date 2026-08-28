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

/* ocean ran this through Exportable.fromJson, which THREW on a malformed entry and took the whole
 * request with it. dropping the bad entry keeps a recommendation coming back when mantle2
 * sends one dud row in a batch of hundreds.
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

export function parseActivities(value: unknown): RecommendActivity[] {
	return Array.isArray(value) ? value.filter(isRecommendActivity) : [];
}

// #endregion

// #region scoring against a user

/** below this on both axes an activity counts as distant from what the user already does */
export const DISTANT_SCORE = 0.2;

function scoreAgainst(all: RecommendActivity[], current: RecommendActivity[]): Scored[] {
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

	return scored;
}

export function isDistant(entry: Scored): boolean {
	return entry.keywordScore < DISTANT_SCORE && entry.typeScore < DISTANT_SCORE;
}

export type SurpriseActivity = {
	activity: RecommendActivity;
	/** true when nothing at all is shared with the user's current set, not merely little */
	unrelated: boolean;
	/** how many candidates were distant enough to be drawn instead */
	pool: number;
};

/* the catalog is 470 items and reads as a searchable list; this is the exploration surface it was
 * missing. same shape as recommendActivity's `different` slot - filter to the distant
 * tail, then sample uniformly - so a re-roll keeps landing somewhere unexpected rather than walking
 * a ranked list. Falls back to the least-related candidate when nothing clears the bar, and to a
 * plain random pick when the user has no activities to be distant from.
 *
 */
export function surpriseActivity(
	all: RecommendActivity[],
	current: RecommendActivity[],
	random: () => number = Math.random
): SurpriseActivity | null {
	if (all.length === 0) return null;

	if (current.length === 0) {
		const pick = all[Math.floor(random() * all.length)] ?? all[all.length - 1]!;
		return { activity: pick, unrelated: true, pool: all.length };
	}

	const scored = scoreAgainst(all, current);
	if (scored.length === 0) return null;

	const distant = scored.filter(isDistant);
	if (distant.length === 0) {
		const worst = [...scored].sort((a, b) => a.totalScore - b.totalScore)[0]!;
		return { activity: worst.activity, unrelated: worst.isNovel, pool: 0 };
	}

	const drawn = distant[Math.floor(random() * distant.length)] ?? distant[distant.length - 1]!;
	return { activity: drawn.activity, unrelated: drawn.isNovel, pool: distant.length };
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
 */
export function recommendActivity(
	all: RecommendActivity[],
	current: RecommendActivity[]
): RecommendActivity[] {
	const scored = scoreAgainst(all, current);

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
	const distant = scored.filter(isDistant);
	const different =
		distant.length > 0
			? distant[Math.floor(Math.random() * distant.length)]?.activity
			: scored[scored.length - 1]?.activity;

	return [first, second, different].filter((a): a is RecommendActivity => a !== undefined);
}

// #endregion
