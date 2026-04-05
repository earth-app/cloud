import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	getSynonyms,
	isValidWord,
	splitContent,
	stripMarkdownCodeFence,
	toOrdinal
} from '../../src/util/lang';

afterEach(() => {
	vi.restoreAllMocks();
});

describe('isValidWord', () => {
	it('returns true when dictionary API includes the queried word', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(JSON.stringify([{ word: 'hello', meanings: [] }]), { status: 200 })
		);

		await expect(isValidWord('hello')).resolves.toBe(true);
	});

	it('returns false for non-ok responses', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('Not found', { status: 404 }));
		await expect(isValidWord('zzzz')).resolves.toBe(false);
	});
});

describe('getSynonyms', () => {
	it('returns normalized unique synonyms excluding the original word', async () => {
		vi.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(
				new Response(JSON.stringify([{ word: 'green', meanings: [] }]), { status: 200 })
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify([
						{
							word: 'green',
							meanings: [
								{
									synonyms: ['Eco', 'Verdant'],
									definitions: [{ synonyms: ['green', 'eco'] }]
								}
							]
						}
					]),
					{ status: 200 }
				)
			);

		const result = await getSynonyms('green');
		expect(result).toContain('eco');
		expect(result).toContain('verdant');
		expect(result.every((syn) => syn !== 'green')).toBe(true);
	});

	it('returns empty array for invalid short words', async () => {
		expect(await getSynonyms('hi')).toEqual([]);
	});
});

describe('splitContent', () => {
	it('splits text into punctuation-safe paragraphs', () => {
		const content =
			'Mr. Smith visited the U.S.A. in 2024. He wrote 3.14 in his notes. However he kept exploring.';
		const paragraphs = splitContent(content);

		expect(paragraphs.length).toBeGreaterThan(0);
		expect(paragraphs.join(' ')).toContain('U.S.A.');
		expect(paragraphs.join(' ')).toContain('3.14');
	});

	it('returns empty array for blank input', () => {
		expect(splitContent('   ')).toEqual([]);
	});
});

describe('toOrdinal', () => {
	it('formats standard ordinal suffixes', () => {
		expect(toOrdinal(1)).toBe('1st');
		expect(toOrdinal(2)).toBe('2nd');
		expect(toOrdinal(3)).toBe('3rd');
		expect(toOrdinal(11)).toBe('11th');
	});
});

describe('stripMarkdownCodeFence', () => {
	it('strips markdown fences and returns raw json string', () => {
		const input = '```json\n{"ok":true}\n```';
		expect(stripMarkdownCodeFence(input)).toBe('{"ok":true}');
	});

	it('stringifies object input', () => {
		expect(stripMarkdownCodeFence({ ok: true })).toBe('{"ok":true}');
	});
});
