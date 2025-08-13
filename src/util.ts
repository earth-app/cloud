export function trimToByteLimit(str: string, byteLimit: number): string {
	const encoder = new TextEncoder();
	const chars = Array.from(str);
	const byteLens: number[] = chars.map((c) => encoder.encode(c).length);
	const cum: number[] = [];
	for (let i = 0; i < byteLens.length; i++) {
		cum[i] = byteLens[i] + (i > 0 ? cum[i - 1] : 0);
	}

	// Binary-search for highest index whose cum[idx] <= byteLimit
	let lo = 0;
	let hi = chars.length - 1;
	let cut = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >>> 1;
		if (cum[mid] <= byteLimit) {
			cut = mid;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}

	// If nothing fits, return empty; else join up to cut
	return cut >= 0 ? chars.slice(0, cut + 1).join('') : '';
}

const BLACKLIST = [
	'kindness',
	'happiness',
	'gratitude',
	'empathy',
	'compassion',
	'forgiveness',
	'love',
	'peace',
	'positivity',
	'hidden',
	'stumbled',
	'discover',
	'discovery',
	'masterpiece',
	'gallery',
	'cave'
];

export function validateCandidate(s: string, maxChars: number, maxWords: number): boolean {
	const START_RE = /^(Who|What|When|Where|Why|How|If)\b/i;
	const ASCII_RE = /^[\x00-\x7F]+$/;
	const VALID_RE = /^[A-Za-z0-9 ,.'\-?]+$/;

	if (!s) return false;
	if (s.includes('\n')) return false;
	if (!s.endsWith('?')) return false;
	if (s.length > maxChars) return false;
	if (s.split(/\s+/).filter(Boolean).length > maxWords) return false;
	if (!START_RE.test(s)) return false;
	if (!ASCII_RE.test(s)) return false;
	if (!VALID_RE.test(s)) return false;
	if ((s.match(/,/g) || []).length > 1) return false;

	const lower = s.toLowerCase();
	if (BLACKLIST.some((b) => lower.includes(b))) return false;
	return true;
}
