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

export function toDataURL(image: Uint8Array | ArrayBuffer, type = 'image/png'): string {
	const bytes = image instanceof Uint8Array ? image : new Uint8Array(image);

	const chunkSize = 0x2000; // 8KB chunks to stay well under call stack/arg limits
	let binary = '';
	for (let i = 0; i < bytes.length; i += chunkSize) {
		const chunk = bytes.subarray(i, i + chunkSize);
		binary += String.fromCharCode.apply(null, Array.from(chunk));
	}

	return `data:${type};base64,` + btoa(binary);
}

export function chunkArray<T>(arr: T[], size: number): Array<T[]> {
	const result = [];
	for (let i = 0; i < arr.length; i += size) {
		result.push(arr.slice(i, i + size));
	}
	return result;
}

export function splitContent(content: string): string[] {
	if (!content || content.trim().length === 0) {
		return [];
	}

	// Split into sentences using common sentence-ending patterns
	const sentenceRegex = /[.!?]+(?=\s+[A-Z]|$)/g;
	const sentences = content
		.split(sentenceRegex)
		.map((s) => s.trim())
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

	// Ensure we don't have any empty paragraphs
	return paragraphs.filter((p) => p.trim().length > 0);
}
