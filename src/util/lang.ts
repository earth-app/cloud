const dictionaryUrl = (word: string) =>
	`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`;

type DictionaryEntry = {
	word: string;
	meanings: {
		definitions: {
			synonyms: string[];
		}[];
		synonyms: string[];
	}[];
};

export async function isValidWord(word: string): Promise<boolean> {
	try {
		const response = await fetch(dictionaryUrl(word));
		if (!response.ok) return false;

		const data: DictionaryEntry[] = await response.json();
		if (!data || !data.length) return false; // in case it's not an array or empty

		// If we have at least one entry, the word is valid
		return data.some((entry) => entry.word.toLowerCase() === word.toLowerCase());
	} catch (error) {
		console.error(`Error checking word validity: ${error}`);
		return false;
	}
}

export async function getSynonyms(word: string) {
	if (!word || word.length < 3) {
		return [];
	}

	if (!(await isValidWord(word))) {
		return [];
	}

	try {
		const response = await fetch(dictionaryUrl(word));
		if (!response.ok) return [];

		const data: DictionaryEntry[] = await response.json();
		if (!data || !data.length) return []; // in case it's not an array or empty

		const synonyms: string[] = [];
		for (const entry of data) {
			for (const meaning of entry.meanings) {
				for (const definition of meaning.definitions) {
					if (definition.synonyms && definition.synonyms.length > 0) {
						synonyms.push(...definition.synonyms);
					}
				}
				if (meaning.synonyms && meaning.synonyms.length > 0) {
					synonyms.push(...meaning.synonyms);
				}
			}
		}

		// Remove duplicates and filter out the original word
		return Array.from(new Set(synonyms))
			.filter((syn) => syn.toLowerCase() !== word.toLowerCase())
			.map((syn) => syn.trim().toLowerCase());
	} catch (error) {
		console.error(`Error checking word validity: ${error}`);
		return [];
	}
}
export function splitContent(content: string): string[] {
	if (!content || content.trim().length === 0) {
		return [];
	}

	// Helper function to ensure proper punctuation
	const ensurePunctuation = (sentence: string): string => {
		const trimmed = sentence.trim();
		if (!trimmed) return trimmed;

		const lastChar = trimmed[trimmed.length - 1];
		if (['.', '!', '?'].includes(lastChar)) {
			return trimmed;
		}

		const questionStarters = [
			'who',
			'what',
			'when',
			'where',
			'why',
			'how',
			'is',
			'are',
			'do',
			'does',
			'did',
			'can',
			'could',
			'would',
			'should',
			'will'
		];

		const firstWord = trimmed.toLowerCase().split(/\s+/)[0];
		if (questionStarters.includes(firstWord)) {
			return trimmed + '?';
		}

		// Otherwise add a period
		return trimmed + '.';
	};

	// Split into sentences using common sentence-ending patterns
	// More nuanced approach that avoids splitting on:
	// - Initials (e.g., "A. A. LastName", "J. Smith", "U.S.A.")
	// - Common abbreviations (e.g., "Mr.", "Mrs.", "Inc.", "etc.")
	// - Numbers with periods (e.g., "3.14", "v2.0")
	// First, protect common patterns that shouldn't be split
	const protectedContent = content
		// Protect single capital letter followed by period and space (initials in names)
		.replace(/\b([A-Z])\.\s+/g, '$1~INITIAL~ ')
		// Protect common titles and abbreviations
		.replace(
			/\b(Mr|Mrs|Ms|Dr|Prof|Sr|Jr|Ph|Esq|Rev|Hon|Capt|Lt|Col|Gen|Sgt|vs|viz|etc|Inc|Corp|Co|Ltd|LLC|Ave|St|Rd|Blvd|Dept|Vol|No|Fig|Ph\.D|M\.D|B\.A|M\.A|B\.S|M\.S|D\.D\.S|J\.D|Ed\.D|Psy\.D)\.\s+/gi,
			'$1~ABBREV~ '
		)
		// Protect acronyms (e.g., U.S.A., N.A.S.A.)
		.replace(/\b([A-Z])\.([A-Z])\.(?:[A-Z]\.)*\b/g, (match) => match.replace(/\./g, '~ACRONYM~'))
		// Protect decimal numbers
		.replace(/\b(\d+)\.(\d+)\b/g, '$1~DECIMAL~$2')
		// Protect common Latin abbreviations
		.replace(/\b(e\.g|i\.e|et al|cf|ca|viz)\.\s+/gi, '$1~LATIN~ ');

	const sentenceRegex = /[.!?]+(?=\s+[A-Z]|$)/g;
	const sentences = protectedContent
		.split(sentenceRegex)
		.map((s) => {
			// Restore protected patterns
			const restored = s
				.replace(/~INITIAL~/g, '.')
				.replace(/~ABBREV~/g, '.')
				.replace(/~ACRONYM~/g, '.')
				.replace(/~DECIMAL~/g, '.')
				.replace(/~LATIN~/g, '.');
			return ensurePunctuation(restored.trim());
		})
		.filter((s) => s.length > 0);

	if (sentences.length === 0) {
		return [content];
	}

	// Transition words that often indicate paragraph breaks
	const transitionWords = [
		'however',
		'therefore',
		'furthermore',
		'moreover',
		'nevertheless',
		'consequently',
		'additionally',
		'meanwhile',
		'in contrast',
		'on the other hand',
		'as a result',
		'in conclusion',
		'for example',
		'for instance',
		'in fact',
		'indeed',
		'similarly',
		'likewise',
		'conversely',
		'nonetheless'
	];

	// Topic shift indicators (words that might indicate a new topic)
	const topicShiftWords = [
		'but',
		'yet',
		'still',
		'although',
		'though',
		'while',
		'whereas',
		'despite',
		'instead',
		'rather',
		'alternatively'
	];

	const paragraphs: string[] = [];
	let currentParagraph: string[] = [];

	for (let i = 0; i < sentences.length; i++) {
		const sentence = sentences[i];
		if (!sentence) continue;

		const sentenceLower = sentence.toLowerCase().trim();

		// Check if this sentence starts with a transition word
		const startsWithTransition = transitionWords.some(
			(word) =>
				sentenceLower.startsWith(word.toLowerCase() + ' ') ||
				sentenceLower.startsWith(word.toLowerCase() + ',')
		);

		// Check if this sentence starts with a topic shift word
		const startsWithTopicShift = topicShiftWords.some(
			(word) =>
				sentenceLower.startsWith(word.toLowerCase() + ' ') ||
				sentenceLower.startsWith(word.toLowerCase() + ',')
		);

		// Determine if we should start a new paragraph
		let shouldBreak = false;

		// Rule 1: Strong transition words often indicate a new paragraph
		if (startsWithTransition && currentParagraph.length >= 2) {
			shouldBreak = true;
		}

		// Rule 2: Avoid paragraphs with more than 4 sentences
		if (currentParagraph.length >= 4) {
			shouldBreak = true;
		}

		// Rule 3: Topic shift words after 3+ sentences suggest a break
		if (startsWithTopicShift && currentParagraph.length >= 3) {
			shouldBreak = true;
		}

		// Rule 4: Very long sentences (>150 chars) after 2+ sentences might warrant a break
		if (sentence.length > 150 && currentParagraph.length >= 2) {
			shouldBreak = true;
		}

		// Rule 5: Short impactful sentences after a longer paragraph can be standalone
		if (sentence.length < 50 && currentParagraph.length >= 3 && i < sentences.length - 1) {
			// Add current sentence to current paragraph and then break
			currentParagraph.push(sentence);
			paragraphs.push(currentParagraph.join(' '));
			currentParagraph = [];
			continue;
		}

		// Apply the break if determined
		if (shouldBreak && currentParagraph.length > 0) {
			paragraphs.push(currentParagraph.join(' '));
			currentParagraph = [sentence];
		} else {
			currentParagraph.push(sentence);
		}
	}

	// Add any remaining sentences as the final paragraph
	if (currentParagraph.length > 0) {
		paragraphs.push(currentParagraph.join(' '));
	}

	// Ensure we don't have any empty paragraphs and all paragraphs end with proper punctuation
	return paragraphs
		.filter((p) => p.trim().length > 0)
		.map((p) => {
			const trimmed = p.trim();
			const lastChar = trimmed[trimmed.length - 1];
			// Ensure paragraph ends with proper punctuation
			if (!['.', '!', '?'].includes(lastChar)) {
				return trimmed + '.';
			}
			return trimmed;
		});
} /**
 * Converts a number to its ordinal form (1st, 2nd, 3rd, etc.)
 * @param num - The number to convert
 * @returns The ordinal string (e.g., "1st", "2nd", "3rd", "4th")
 */

export function toOrdinal(num: number): string {
	const j = num % 10;
	const k = num % 100;

	if (j === 1 && k !== 11) {
		return num + 'st';
	}
	if (j === 2 && k !== 12) {
		return num + 'nd';
	}
	if (j === 3 && k !== 13) {
		return num + 'rd';
	}
	return num + 'th';
} /**
 * Strips markdown code fences from AI-generated responses and normalizes to JSON string.
 * Handles various formats:
 * - Markdown fenced: ```json\n{...}\n```
 * - Plain JSON string: {"key": "value"}
 * - Already parsed object: {key: "value"}
 * - JSON.stringify output: "{\"key\":\"value\"}"
 * - Edge cases: multiple fences, whitespace, missing closing fence, CRLF/CR/LF line endings
 *
 * @param text - The text potentially wrapped in markdown code fences, or an already parsed object
 * @returns The cleaned JSON string ready for parsing
 */

export function stripMarkdownCodeFence(text: string | object | any): string {
	// Handle already-parsed objects
	if (text && typeof text === 'object') {
		return JSON.stringify(text);
	}

	// Handle non-string primitives
	if (!text || typeof text !== 'string') {
		return text || '';
	}

	let cleaned = text.trim();

	// If it doesn't contain code fences, return as-is
	if (!cleaned.includes('```')) {
		return cleaned;
	}
	// Handle multiple code fences (keep stripping until none remain)
	let previousLength = -1;
	while (cleaned.length !== previousLength && cleaned.includes('```')) {
		previousLength = cleaned.length;

		// Match opening fence with optional language identifier
		// Handles: ```json, ```typescript, ```javascript, ``` (no language), etc.
		// (?:\r\n|\r|\n)? handles CRLF, CR, and LF line endings
		cleaned = cleaned.replace(/^```[a-z]*\s*(?:\r\n|\r|\n)?/i, '');

		// Match closing fence with any line ending type
		cleaned = cleaned.replace(/(?:\r\n|\r|\n)?```\s*$/i, '');

		cleaned = cleaned.trim();
	}

	return cleaned;
}
