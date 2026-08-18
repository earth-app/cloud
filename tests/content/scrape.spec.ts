import { describe, expect, it } from 'vitest';
import {
	createArticle,
	feedKeywords,
	formatAuthors,
	inflateInvertedAbstract,
	isUsablePage,
	normalizeLink,
	parseFeed,
	REGISTERED_SCRAPERS,
	stripHtml,
	termHits,
	type Page,
	type PageMetadata
} from '../../src/content/scrape';

/*
 * The pure half of the boat rewrite. Network-bound scrapers are exercised in the integration lane;
 * everything here is the parsing and formatting that ocean's kotlin did, pinned so the `Page` shape
 * mantle2 and the article generator consume cannot drift.
 */

describe('normalizeLink', () => {
	it('upgrades http to https', () => {
		expect(normalizeLink('https://a.com', 'http://b.com/x')).toBe('https://b.com/x');
	});

	it('resolves protocol-relative and root-relative links', () => {
		expect(normalizeLink('https://a.com', '//cdn.b.com/x')).toBe('https://cdn.b.com/x');
		expect(normalizeLink('https://a.com', '/article/1')).toBe('https://a.com/article/1');
	});

	it('leaves an absolute link alone and drops empties', () => {
		expect(normalizeLink('https://a.com', 'https://b.com/x')).toBe('https://b.com/x');
		expect(normalizeLink('https://a.com', '')).toBeNull();
		expect(normalizeLink('https://a.com', null)).toBeNull();
	});
});

describe('formatAuthors', () => {
	it('matches the citation forms ocean produced', () => {
		expect(formatAuthors([])).toBe('Unknown Author');
		expect(formatAuthors(['A'])).toBe('A');
		expect(formatAuthors(['A', 'B'])).toBe('A and B');
		expect(formatAuthors(['A', 'B', 'C'])).toBe('A, B and C');
		expect(formatAuthors(['A', 'B', 'C', 'D'])).toBe('A, B, et. al');
	});

	it('ignores blank names', () => {
		expect(formatAuthors(['A', '  ', 'B'])).toBe('A and B');
	});
});

describe('stripHtml', () => {
	it('removes markup and decodes the common entities', () => {
		expect(stripHtml('<p>Hello&nbsp;&amp; welcome</p>')).toBe('Hello & welcome');
	});

	it('drops script and style bodies entirely', () => {
		expect(stripHtml('<style>a{b:c}</style><p>text</p><script>var x=1</script>')).toBe('text');
	});
});

describe('parseFeed', () => {
	const feed = `<?xml version="1.0"?>
	<rss version="2.0"><channel>
		<title>Test Feed</title>
		<link>https://example.com</link>
		<item>
			<title><![CDATA[First Post]]></title>
			<link>https://example.com/1</link>
			<description>&lt;p&gt;A summary&lt;/p&gt;</description>
			<dc:creator>Jane Doe</dc:creator>
			<pubDate>Mon, 01 Jan 2026 00:00:00 GMT</pubDate>
		</item>
		<item>
			<title>Second Post</title>
			<link>https://example.com/2</link>
		</item>
	</channel></rss>`;

	it('reads every item', () => {
		const pages = parseFeed(feed, 'https://example.com/feed');
		expect(pages).toHaveLength(2);
		expect(pages[0]?.title).toBe('First Post');
		expect(pages[0]?.url).toBe('https://example.com/1');
	});

	it('prefers the item creator and falls back to the channel title', () => {
		const pages = parseFeed(feed, 'https://example.com/feed');
		expect(pages[0]?.author).toBe('Jane Doe');
		expect(pages[1]?.author).toBe('Test Feed');
	});

	it('strips html out of summaries', () => {
		const pages = parseFeed(feed, 'https://example.com/feed');
		expect(pages[0]?.abstract).toBe('A summary');
	});

	// ocean substituted these placeholders rather than leaving a field empty
	it('substitutes placeholders when an item has no body', () => {
		const pages = parseFeed(feed, 'https://example.com/feed');
		expect(pages[1]?.abstract).toBe('No abstract available.');
		expect(pages[1]?.content).toBe('No content available.');
	});

	it('derives the favicon from the feed origin', () => {
		const pages = parseFeed(feed, 'https://example.com/feed');
		expect(pages[0]?.favicon).toBe('https://example.com/favicon.ico');
	});

	it('reads atom entries, where the url is an attribute', () => {
		const atom = `<feed><title>Atom</title>
			<entry><title>E1</title><link href="https://example.com/a1"/><summary>s</summary></entry>
		</feed>`;
		const pages = parseFeed(atom, 'https://example.com/atom');
		expect(pages[0]?.url).toBe('https://example.com/a1');
	});

	it('skips entries with no url or no title', () => {
		const broken = `<rss><channel><title>T</title>
			<item><description>orphan</description></item>
		</channel></rss>`;
		expect(parseFeed(broken, 'https://example.com/f')).toEqual([]);
	});
});

describe('createArticle', () => {
	const md: PageMetadata = {
		title: 'Fallback Title',
		links: [],
		sectionText: '',
		meta: {
			citation_title: ['Real Title'],
			citation_author: ['Ada Lovelace', 'Alan Turing'],
			citation_journal_title: ['journal of things'],
			citation_volume: ['4'],
			citation_issue: ['2'],
			citation_firstpage: ['10'],
			citation_lastpage: ['20'],
			citation_date: ['2026-01-01'],
			citation_doi: ['10.1000/abc'],
			citation_abstract: ['An abstract'],
			citation_keywords: ['alpha, beta; gamma']
		}
	};

	it('prefers citation_title over the document title', () => {
		expect(createArticle('https://x.com/a', md).title).toBe('Real Title');
	});

	it('falls back to the document title when there is no citation', () => {
		const bare: PageMetadata = { ...md, meta: {} };
		expect(createArticle('https://x.com/a', bare).title).toBe('Fallback Title');
	});

	it('builds the container string the way ocean did', () => {
		expect(createArticle('https://x.com/a', md).source).toBe(
			'Vol. 4, Issue 2, Journal Of Things, pp. 10-20'
		);
	});

	it('links the doi through doi.org', () => {
		expect(createArticle('https://x.com/a', md).links?.DOI).toBe('https://doi.org/10.1000/abc');
	});

	// ocean split conjoined keyword strings on , ; . / | and " and "
	it('splits conjoined keywords', () => {
		expect(createArticle('https://x.com/a', md).keywords).toEqual(['alpha', 'beta', 'gamma']);
	});

	it('lets the caller override a field it knows better', () => {
		const page = createArticle('https://x.com/a', md, { content: 'body text' });
		expect(page.content).toBe('body text');
	});
});

describe('isUsablePage', () => {
	const base = createArticle('https://x.com/a', {
		title: 'T',
		links: [],
		sectionText: '',
		meta: { citation_author: ['A'] }
	});

	it('requires url, title, content and author', () => {
		expect(isUsablePage({ ...base, content: 'body' })).toBe(true);
		expect(isUsablePage({ ...base, content: 'body', url: '' })).toBe(false);
		expect(isUsablePage({ ...base, content: '' })).toBe(false);
	});
});

describe('registry', () => {
	// a floor, not an exact count, so adding a source is not a test edit; the point is that
	// article variety cannot silently shrink
	it('keeps at least 25 sources', () => {
		expect(REGISTERED_SCRAPERS.length).toBeGreaterThanOrEqual(25);
	});

	it('names every source uniquely', () => {
		const names = REGISTERED_SCRAPERS.map((s) => s.name);
		expect(new Set(names).size).toBe(names.length);
	});

	it('covers the seven journal sources', () => {
		const names = REGISTERED_SCRAPERS.map((s) => s.name);
		expect(names).toEqual(
			expect.arrayContaining([
				'PubMed',
				'DOAJ',
				'IMEJ',
				'SpringerOpen',
				'Europe PMC',
				'PLOS',
				'OpenAlex'
			])
		);
	});

	it('drops the sources that failed the drop-in bar', () => {
		const urls = REGISTERED_SCRAPERS.map((s) => s.baseUrl);
		// 301s to a page with no feed
		expect(urls.some((url) => url.includes('newscientist.com'))).toBe(false);
		// 403 anti-scraping
		expect(urls.some((url) => url.includes('rei.com'))).toBe(false);
	});

	it('marks every source as a journal or a magazine', () => {
		for (const scraper of REGISTERED_SCRAPERS) {
			expect(['journal', 'magazine']).toContain(scraper.kind);
		}
	});

	// selection prefers a general-audience piece, so the magazines have to outnumber the journals
	it('weights the registry toward general-audience sources', () => {
		const magazines = REGISTERED_SCRAPERS.filter((s) => s.kind === 'magazine');
		const journals = REGISTERED_SCRAPERS.filter((s) => s.kind === 'journal');
		expect(magazines.length).toBeGreaterThan(journals.length);
	});
});

describe('feedKeywords', () => {
	// the regression that mattered: no keywords meant findArticle dropped every feed item, so
	// only the journal APIs could ever publish
	it('reads rss category bodies', () => {
		expect(
			feedKeywords('<item><category>Nature</category><category>Birds</category></item>')
		).toEqual(['Nature', 'Birds']);
	});

	it('reads atom term attributes', () => {
		expect(
			feedKeywords('<entry><category term="Ecology"/><category term="Soil"/></entry>')
		).toEqual(['Ecology', 'Soil']);
	});

	it('splits conjoined values and folds duplicates case-insensitively', () => {
		expect(feedKeywords('<category>Art, Craft</category><category>art</category>')).toEqual([
			'Art',
			'Craft'
		]);
	});

	it('drops cdata markup, overlong values and empties', () => {
		const long = 'x'.repeat(40);
		expect(feedKeywords(`<category><![CDATA[<b>Hiking</b>]]></category>`)).toEqual(['Hiking']);
		expect(feedKeywords(`<category>${long}</category>`)).toEqual([]);
		expect(feedKeywords('<category></category>')).toEqual([]);
	});

	it('caps at 25 values', () => {
		const many = Array.from({ length: 40 }, (_, i) => `<category>t${i}</category>`).join('');
		expect(feedKeywords(many)).toHaveLength(25);
	});

	it('returns nothing for a feed with no categories', () => {
		expect(feedKeywords('<item><title>t</title></item>')).toEqual([]);
	});
});

describe('parseFeed keywords', () => {
	it('carries feed categories onto the page', () => {
		const xml =
			'<rss><channel><title>Feed</title><link>https://f.com</link>' +
			'<item><title>T</title><link>https://f.com/a</link><description>Body</description>' +
			'<category>Nature</category></item></channel></rss>';

		expect(parseFeed(xml, 'https://f.com/feed')[0]!.keywords).toEqual(['Nature']);
	});
});

describe('termHits', () => {
	const page = (over: Partial<Page> = {}): Page => ({
		url: 'https://a.com/1',
		title: 'Beekeeping in cities',
		author: 'A',
		source: 'S',
		date: '2026',
		links: {},
		abstract: 'Hives on rooftops',
		content: 'Urban apiaries',
		theme_color: '#fff',
		keywords: ['Pollinators'],
		...over
	});

	it('counts terms across title, abstract, content and keywords', () => {
		expect(termHits(page(), ['beekeeping'])).toBe(1);
		expect(termHits(page(), ['rooftops'])).toBe(1);
		expect(termHits(page(), ['apiaries'])).toBe(1);
		expect(termHits(page(), ['pollinators'])).toBe(1);
	});

	it('counts each matching term once and ignores misses', () => {
		expect(termHits(page(), ['beekeeping', 'rooftops', 'volcanology'])).toBe(2);
	});

	it('is zero for an empty term list', () => {
		expect(termHits(page(), [])).toBe(0);
	});
});

describe('inflateInvertedAbstract', () => {
	it('rebuilds word order from the position index', () => {
		expect(inflateInvertedAbstract({ Urban: [0], foraging: [1], is: [2], common: [3] })).toBe(
			'Urban foraging is common'
		);
	});

	it('handles a word repeated at several positions', () => {
		expect(inflateInvertedAbstract({ a: [0, 2], b: [1] })).toBe('a b a');
	});

	it('skips holes and invalid positions rather than emitting undefined', () => {
		expect(inflateInvertedAbstract({ a: [0], b: [2], c: [-1] })).toBe('a b');
	});

	it('returns empty for a missing index', () => {
		expect(inflateInvertedAbstract(undefined)).toBe('');
	});
});
