import { describe, expect, it, vi } from 'vitest';
import {
	deleteEventThumbnail,
	extractLocationFromEventName,
	getEventThumbnail,
	parseBirthdayEventName,
	uploadEventThumbnail,
	uploadPlaceThumbnail
} from '../../src/content/thumbnails';
import { classifyEventEntry, isPlaceBirthdaySource } from '../../src/util/ai';
import { parseCSVLine } from '@earth-app/moho';
import { env } from 'cloudflare:workers';
import { type Bindings, type ExecutionCtxLike } from '../../src/util/types';

// Load every moho CSV at test build time. This lets us assert that the place-birthday
// classifier and the birthday-name parser agree with the real source data — not just
// hand-picked fixtures. If moho ships a new CSV with a different naming convention,
// these tests fail loudly so the classifier can be updated.
const ALL_MOHO_CSVS = (
	import.meta as unknown as {
		glob: (
			pattern: string,
			options: { query?: string; import?: string; eager?: boolean }
		) => Record<string, string>;
	}
).glob('../../node_modules/@earth-app/moho/src/data/**/*.csv', {
	query: '?raw',
	import: 'default',
	eager: true
});

const PLACE_BIRTHDAY_RELATIVE_PATHS = new Set([
	'birthdays/countries.csv',
	'birthdays/us/cities.csv',
	'birthdays/us/counties.csv',
	'birthdays/us/territories.csv',
	'birthdays/ca/cities.csv',
	'birthdays/ca/provinces.csv'
]);

const ORGANIZATION_BIRTHDAY_RELATIVE_PATHS = new Set([
	'birthdays/companies.csv',
	'birthdays/international_orgs.csv',
	'birthdays/us/colleges.csv'
]);

function toRelativeMohoPath(absolutePath: string): string {
	const marker = 'moho/src/data/';
	const idx = absolutePath.indexOf(marker);
	return idx >= 0 ? absolutePath.slice(idx + marker.length) : absolutePath;
}

function* mohoEntries(): Generator<{ relativePath: string; name: string; lineIndex: number }> {
	for (const [absolute, contents] of Object.entries(ALL_MOHO_CSVS)) {
		const relativePath = toRelativeMohoPath(absolute);
		const lines = contents.split('\n');
		for (let i = 0; i < lines.length; i++) {
			const raw = lines[i] ?? '';
			const trimmed = raw.trim();
			if (!trimmed) continue;
			const name = trimmed.split(',')[0]?.trim();
			if (!name) continue;
			yield { relativePath, name, lineIndex: i + 1 };
		}
	}
}

function createBindings(): Bindings {
	return {
		...env,
		NCBI_API_KEY: 'ncbi'
	} as unknown as Bindings;
}

function createCtx(): ExecutionCtxLike {
	return {
		waitUntil: (_promise: Promise<unknown>) => {}
	};
}

describe('parseBirthdayEventName', () => {
	it('parses possessive birthday names with ordinals', () => {
		const parsed = parseBirthdayEventName("Vallejo's 173rd Birthday");
		expect(parsed?.rawLocationName).toBe('Vallejo');
		expect(parsed?.searchLocationName).toBe('Vallejo');
		expect(parsed?.possessive).toBe("'s");
		expect(parsed?.hasOrdinal).toBe(true);
	});

	it('parses trailing-apostrophe possessive birthday names', () => {
		const parsed = parseBirthdayEventName("Bahamas' Birthday");
		expect(parsed?.rawLocationName).toBe('Bahamas');
		expect(parsed?.searchLocationName).toBe('Bahamas');
		expect(parsed?.possessive).toBe("'");
		expect(parsed?.hasOrdinal).toBe(false);
	});

	it('normalizes HTML apostrophe entities', () => {
		const parsed = parseBirthdayEventName('Raleigh (NC)&apos;s Birthday');
		expect(parsed?.rawLocationName).toBe('Raleigh (NC)');
		expect(parsed?.searchLocationName).toBe('Raleigh, NC');
		expect(parsed?.possessive).toBe("'s");
	});

	it('rejects names without possessive or ordinal marker', () => {
		expect(parseBirthdayEventName('Global Birthday')).toBeNull();
		expect(parseBirthdayEventName('Birthday Celebration')).toBeNull();
	});

	it('returns null for non-birthday names', () => {
		expect(parseBirthdayEventName('Community Cleanup Day')).toBeNull();
	});
});

describe('extractLocationFromEventName', () => {
	it('normalizes parenthetical disambiguators', () => {
		expect(extractLocationFromEventName("Springfield (IL)'s Birthday")).toBe('Springfield, IL');
	});

	it('supports trailing-apostrophe birthday names', () => {
		expect(extractLocationFromEventName("Bahamas' Birthday")).toBe('Bahamas');
	});
});

describe('uploadPlaceThumbnail', () => {
	it('returns null tuple for empty place names', async () => {
		const [image, author] = await uploadPlaceThumbnail('   ', 1n, createBindings(), createCtx());
		expect(image).toBeNull();
		expect(author).toBeNull();
	});
});

describe('uploadEventThumbnail', () => {
	it('stores non-empty image bytes without conversion when disabled', async () => {
		const bindings = createBindings();
		const data = new Uint8Array([1, 2, 3, 4]);
		const stored = await uploadEventThumbnail(1001n, data, 'Tester', bindings, createCtx(), false);
		expect(Array.from(stored)).toEqual([1, 2, 3, 4]);
	});

	it('throws for empty image payloads', async () => {
		await expect(
			uploadEventThumbnail(1002n, new Uint8Array(), 'Tester', createBindings(), createCtx(), false)
		).rejects.toThrow('Event thumbnail image cannot be empty');
	});
});

describe('getEventThumbnail', () => {
	it('retrieves previously uploaded thumbnail + author', async () => {
		const bindings = createBindings();
		await uploadEventThumbnail(
			2001n,
			new Uint8Array([8, 9]),
			'Author',
			bindings,
			createCtx(),
			false
		);
		const [image, author] = await getEventThumbnail(2001n, bindings);

		expect(Array.from(image || [])).toEqual([8, 9]);
		expect(author).toBe('Author');
	});

	it('treats empty stored object as missing thumbnail', async () => {
		const bindings = createBindings();
		await bindings.R2.put('events/2002/thumbnail.webp', new Uint8Array());
		await bindings.KV.put('event:2002:thumbnail:author', 'Author');

		const [image, author] = await getEventThumbnail(2002n, bindings);
		expect(image).toBeNull();
		expect(author).toBeNull();
	});
});

describe('deleteEventThumbnail', () => {
	it('removes thumbnail object and author metadata', async () => {
		const bindings = createBindings();
		await uploadEventThumbnail(3001n, new Uint8Array([7]), 'Author', bindings, createCtx(), false);
		await deleteEventThumbnail(3001n, bindings, createCtx());

		const [image, author] = await getEventThumbnail(3001n, bindings);
		expect(image).toBeNull();
		expect(author).toBeNull();
	});
});

describe('real moho data classification', () => {
	it('loaded at least one entry from every shipped moho CSV', () => {
		const seenRelativePaths = new Set<string>();
		for (const entry of mohoEntries()) {
			seenRelativePaths.add(entry.relativePath);
		}

		const expectedSubset = [
			...PLACE_BIRTHDAY_RELATIVE_PATHS,
			...ORGANIZATION_BIRTHDAY_RELATIVE_PATHS,
			'anniversaries/computers.csv',
			'events.csv',
			'events_d.csv'
		];

		for (const path of expectedSubset) {
			expect(seenRelativePaths.has(path), `expected entries from ${path}`).toBe(true);
		}
	});

	it('classifies every place-CSV entry as place_birthday with a parseable name', () => {
		const failures: string[] = [];
		let placeEntryCount = 0;

		for (const { relativePath, name, lineIndex } of mohoEntries()) {
			if (!PLACE_BIRTHDAY_RELATIVE_PATHS.has(relativePath)) continue;
			placeEntryCount++;

			const kind = classifyEventEntry({ name, source: relativePath });
			if (kind !== 'place_birthday') {
				failures.push(`${relativePath}:${lineIndex} "${name}" classified as ${kind}`);
				continue;
			}

			const parsed = parseBirthdayEventName(name);
			if (!parsed) {
				failures.push(`${relativePath}:${lineIndex} "${name}" did not parse as birthday name`);
				continue;
			}

			if (!parsed.searchLocationName) {
				failures.push(`${relativePath}:${lineIndex} "${name}" produced empty searchLocationName`);
			}
		}

		expect(placeEntryCount, 'should have iterated some place-birthday rows').toBeGreaterThan(0);
		expect(failures, failures.slice(0, 10).join('\n')).toEqual([]);
	});

	it('classifies every organization-CSV entry as organization_birthday (never place)', () => {
		const failures: string[] = [];
		let orgEntryCount = 0;

		for (const { relativePath, name, lineIndex } of mohoEntries()) {
			if (!ORGANIZATION_BIRTHDAY_RELATIVE_PATHS.has(relativePath)) continue;
			orgEntryCount++;

			const kind = classifyEventEntry({ name, source: relativePath });
			if (kind !== 'organization_birthday') {
				failures.push(`${relativePath}:${lineIndex} "${name}" classified as ${kind}`);
			}
			if (isPlaceBirthdaySource(relativePath)) {
				failures.push(
					`${relativePath}:${lineIndex} "${name}" source incorrectly matched isPlaceBirthdaySource`
				);
			}
		}

		expect(orgEntryCount, 'should have iterated some organization-birthday rows').toBeGreaterThan(
			0
		);
		expect(failures, failures.slice(0, 10).join('\n')).toEqual([]);
	});

	it('classifies anniversaries/ entries as historical_anniversary', () => {
		const failures: string[] = [];
		let count = 0;

		for (const { relativePath, name, lineIndex } of mohoEntries()) {
			if (!relativePath.startsWith('anniversaries/')) continue;
			count++;

			const kind = classifyEventEntry({ name, source: relativePath });
			if (kind !== 'historical_anniversary') {
				failures.push(`${relativePath}:${lineIndex} "${name}" classified as ${kind}`);
			}
			if (isPlaceBirthdaySource(relativePath)) {
				failures.push(
					`${relativePath}:${lineIndex} "${name}" source incorrectly matched isPlaceBirthdaySource`
				);
			}
		}

		expect(count).toBeGreaterThan(0);
		expect(failures, failures.slice(0, 10).join('\n')).toEqual([]);
	});

	it('parses every shipped CSV row through moho parseCSVLine without crashing', () => {
		const failures: string[] = [];
		let parsed = 0;

		for (const [absolute, contents] of Object.entries(ALL_MOHO_CSVS)) {
			const relativePath = toRelativeMohoPath(absolute);
			const lines = contents.split('\n');
			for (let i = 0; i < lines.length; i++) {
				const line = (lines[i] ?? '').trim();
				if (!line) continue;
				try {
					const entry = parseCSVLine(line, relativePath);
					if (entry) parsed++;
				} catch (err) {
					failures.push(
						`${relativePath}:${i + 1} "${line}" threw: ${err instanceof Error ? err.message : err}`
					);
				}
			}
		}

		expect(parsed).toBeGreaterThan(0);
		expect(failures, failures.slice(0, 10).join('\n')).toEqual([]);
	});
});

describe('mock place-birthday source detection (boundary cases)', () => {
	it('matches us/ and ca/ place subdirectories', () => {
		expect(isPlaceBirthdaySource('birthdays/us/cities.csv')).toBe(true);
		expect(isPlaceBirthdaySource('birthdays/us/counties.csv')).toBe(true);
		expect(isPlaceBirthdaySource('birthdays/us/territories.csv')).toBe(true);
		expect(isPlaceBirthdaySource('birthdays/ca/cities.csv')).toBe(true);
		expect(isPlaceBirthdaySource('birthdays/ca/provinces.csv')).toBe(true);
	});

	it('rejects nested non-place subdirectories', () => {
		expect(isPlaceBirthdaySource('birthdays/us/colleges.csv')).toBe(false);
		expect(isPlaceBirthdaySource('birthdays/ca/colleges.csv')).toBe(false);
	});

	it('rejects root-level non-place files', () => {
		expect(isPlaceBirthdaySource('birthdays/companies.csv')).toBe(false);
		expect(isPlaceBirthdaySource('birthdays/international_orgs.csv')).toBe(false);
		expect(isPlaceBirthdaySource('birthdays/notes.csv')).toBe(false);
	});

	it('rejects empty / undefined sources', () => {
		expect(isPlaceBirthdaySource('')).toBe(false);
		expect(isPlaceBirthdaySource(undefined)).toBe(false);
	});

	it('classifies hand-picked mock entries the same way real data would', () => {
		expect(
			classifyEventEntry({ name: "Atlanta's Birthday", source: 'birthdays/us/cities.csv' })
		).toBe('place_birthday');
		expect(
			classifyEventEntry({
				name: "Autauga County (AL)'s Birthday",
				source: 'birthdays/us/counties.csv'
			})
		).toBe('place_birthday');
		expect(
			classifyEventEntry({ name: "Bahamas' Birthday", source: 'birthdays/countries.csv' })
		).toBe('place_birthday');
		expect(classifyEventEntry({ name: "3M's Birthday", source: 'birthdays/companies.csv' })).toBe(
			'organization_birthday'
		);
		expect(
			classifyEventEntry({
				name: "Adelphi University's Birthday",
				source: 'birthdays/us/colleges.csv'
			})
		).toBe('organization_birthday');
		expect(
			classifyEventEntry({
				name: "African Union's Birthday",
				source: 'birthdays/international_orgs.csv'
			})
		).toBe('organization_birthday');
	});
});
