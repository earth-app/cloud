const dictionaryUrl = (word: string) =>
	`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`;

type DictionaryEntry = {
	word: string;
	meanings: {
		definitions: {
			synonyms: string[];
		}[];
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
	try {
		const response = await fetch(dictionaryUrl(word));
		if (!response.ok) return [];

		const data: DictionaryEntry[] = await response.json();
		if (!data || !data.length) return []; // in case it's not an array or empty

		const synonyms: string[] = [];
		for (const entry of data)
			for (const meaning of entry.meanings)
				for (const definition of meaning.definitions)
					if (definition.synonyms && definition.synonyms.length > 0) {
						synonyms.push(...definition.synonyms);
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
