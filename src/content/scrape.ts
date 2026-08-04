import type { OceanArticle } from '../util/types';

// #region constants

export const PER_PAGE = 75;
export const MIN_CONTENT_SIZE = 100;

/** every request is bounded; a hung feed must not hold an entire article-generation run */
const FETCH_TIMEOUT_MS = 12_000;

const NO_ABSTRACT = 'No abstract available.';
const NO_CONTENT = 'No content available.';

// #endregion

// #region types

export type Page = OceanArticle;

export type Scraper = {
	name: string;
	baseUrl: string;
	tags: string[];
	search(query: string, pageLimit: number, keys: ApiKeys): Promise<Page[]>;
};

export type ApiKeys = Readonly<Record<string, string>>;

// #endregion

// #region helpers

/**
 * Resolve a possibly-relative link against a base, forcing https.
 *
 * @param baseUrl origin to resolve against
 * @param link raw href
 */
export function normalizeLink(baseUrl: string, link: string | null | undefined): string | null {
	if (!link) return null;
	if (link.startsWith('http://')) return link.replace('http://', 'https://');
	if (link.startsWith('//')) return `https:${link}`;
	if (link.startsWith('/')) return `${baseUrl}${link}`;

	return link;
}

/**
 * Render an author list the way a citation would.
 *
 * @param authors author names, already trimmed
 */
export function formatAuthors(authors: string[]): string {
	const a = authors.filter((x) => x.trim().length > 0);
	if (a.length === 0) return 'Unknown Author';
	if (a.length === 1) return a[0]!;
	if (a.length === 2) return `${a[0]} and ${a[1]}`;
	if (a.length === 3) return `${a[0]}, ${a[1]} and ${a[2]}`;

	return `${a[0]}, ${a[1]}, et. al`;
}

/**
 * Strip markup and collapse whitespace.
 *
 * Runs the tag pass TWICE around entity decoding on purpose: feeds carry summaries both as raw
 * markup and as escaped markup (`&lt;p&gt;`), so decoding first would leave real tags behind and
 * decoding last would leave escaped ones.
 *
 * @param input raw feed text
 */
export function stripHtml(input: string): string {
	const tags = (text: string) =>
		text
			.replace(/<script[\s\S]*?<\/script>/gi, ' ')
			.replace(/<style[\s\S]*?<\/style>/gi, ' ')
			.replace(/<[^>]+>/g, ' ');

	const entities = (text: string) =>
		text
			.replace(/&nbsp;/g, ' ')
			.replace(/&lt;/g, '<')
			.replace(/&gt;/g, '>')
			.replace(/&quot;/g, '"')
			.replace(/&#39;/g, "'")
			.replace(/&amp;/g, '&');

	return tags(entities(tags(input)))
		.replace(/\s+/g, ' ')
		.trim();
}

async function fetchText(url: string): Promise<string> {
	const res = await fetch(url, {
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		headers: { 'User-Agent': 'EarthApp/1.0 (+https://earth-app.com)' }
	});
	if (!res.ok) throw new Error(`${res.status} from ${url}`);

	return await res.text();
}

// #endregion

// #region html metadata

export type PageMetadata = {
	meta: Record<string, string[]>;
	title: string;
	links: string[];
	sectionText: string;
};

/**
 * Read a page's meta tags, title, anchors and body text in ONE streaming pass.
 *
 * Replaces shovel's `fetchDocument().metadata` / `querySelectorAll`. HTMLRewriter never builds a
 * DOM, which is what keeps this viable inside a worker's memory budget on a long article.
 *
 * @param url page to read
 * @param linkSelector optional css selector whose hrefs should be collected
 * @param textSelector optional css selector whose text should be concatenated
 */
export async function fetchPageMetadata(
	url: string,
	linkSelector?: string,
	textSelector?: string
): Promise<PageMetadata> {
	const res = await fetch(url, {
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		headers: { 'User-Agent': 'EarthApp/1.0 (+https://earth-app.com)' }
	});
	if (!res.ok) throw new Error(`${res.status} from ${url}`);

	const meta: Record<string, string[]> = {};
	const links: string[] = [];
	let title = '';
	let inTitle = false;
	let sectionText = '';

	const push = (key: string, value: string) => {
		if (!key || !value) return;
		(meta[key] ??= []).push(value);
	};

	let rewriter = new HTMLRewriter()
		.on('meta', {
			element(el) {
				const value = el.getAttribute('content');
				if (!value) return;
				// citation_* uses `name`; open-graph uses `property`
				const key = el.getAttribute('name') ?? el.getAttribute('property');
				if (key) push(key.toLowerCase(), value);
			}
		})
		.on('title', {
			element() {
				inTitle = true;
			},
			text(chunk) {
				if (inTitle) title += chunk.text;
				if (chunk.lastInTextNode) inTitle = false;
			}
		})
		.on('link[rel~="icon"]', {
			element(el) {
				const href = el.getAttribute('href');
				if (href) push('__favicon', href);
			}
		});

	if (linkSelector) {
		rewriter = rewriter.on(linkSelector, {
			element(el) {
				const href = el.getAttribute('href');
				if (href) links.push(href);
			}
		});
	}

	if (textSelector) {
		rewriter = rewriter.on(textSelector, {
			text(chunk) {
				sectionText += chunk.text;
			}
		});
	}

	// consume the stream so the handlers run
	await rewriter.transform(res).arrayBuffer();

	return { meta, title: title.trim(), links, sectionText: sectionText.replace(/\s+/g, ' ').trim() };
}

/**
 * Build a `Page` from citation metadata. Port of ocean's `Scraper.createArticle`.
 *
 * @param href canonical url of the article
 * @param md metadata from {@link fetchPageMetadata}
 * @param overrides fields the caller already knows better than the metadata
 */
export function createArticle(href: string, md: PageMetadata, overrides: Partial<Page> = {}): Page {
	const first = (key: string): string | undefined => md.meta[key]?.[0];

	const title = first('citation_title') ?? md.title ?? 'Unknown Title';

	const volume = first('citation_volume') ? `Vol. ${first('citation_volume')}, ` : '';
	const issue = first('citation_issue') ? `Issue ${first('citation_issue')}, ` : '';
	const journal = (
		first('citation_journal_title') ??
		first('citation_publisher') ??
		'Unknown Journal'
	)
		.split(' ')
		.map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
		.join(' ');

	const firstPage = first('citation_firstpage');
	const lastPage = first('citation_lastpage');
	const pp =
		firstPage && lastPage
			? `, pp. ${firstPage}-${lastPage}`
			: firstPage
				? `, p. ${firstPage}`
				: lastPage
					? `, p. ${lastPage}`
					: '';

	const source = `${volume}${issue}${journal}${pp}`.trim() || 'Unknown Container';

	const date =
		first('citation_date') ??
		first('citation_online_date') ??
		first('citation_publication_date') ??
		'Unknown Date';

	const links: Record<string, string> = {};
	if (first('citation_pdf_url')) links.PDF = first('citation_pdf_url')!;
	if (first('citation_doi')) links.DOI = `https://doi.org/${first('citation_doi')}`;
	if (first('citation_issn')) {
		links.ISSN = `https://portal.issn.org/resource/ISSN/${first('citation_issn')}`;
	}

	// ocean split conjoined keyword strings after collecting them
	const rawKeywords = [
		...(md.meta['citation_keywords'] ?? md.meta['dc.subject'] ?? []),
		...(md.meta['citation_article_type'] ?? []),
		...(md.meta['og:type'] ?? [])
	];
	const keywords = rawKeywords
		.flatMap((kw) => kw.split(/,|;|\.|\/|\||\sand\s/))
		.map((k) => k.trim())
		.filter((k) => k.length > 0);

	return {
		url: href,
		title,
		author: formatAuthors(md.meta['citation_author'] ?? []),
		source,
		date,
		links,
		favicon: normalizeLink(new URL(href).origin, md.meta['__favicon']?.[0]) ?? '',
		abstract: first('citation_abstract')?.trim() || NO_ABSTRACT,
		content: NO_CONTENT,
		theme_color: first('theme_color') ?? '#ffffff',
		keywords,
		...overrides
	};
}

/**
 * ocean's `Page.validate0`: url, title, content and author must all be present.
 *
 * @param page candidate page
 */
export function isUsablePage(page: Page): boolean {
	return Boolean(page.url && page.title && page.content && page.author);
}

// #endregion

// #region rss

/** pull the inner text of the first `<tag>` in a chunk of xml */
function xmlTag(xml: string, tag: string): string | undefined {
	const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
	if (!m) return undefined;

	return (
		m[1]!
			.replace(/^<!\[CDATA\[/, '')
			.replace(/\]\]>$/, '')
			.trim() || undefined
	);
}

/**
 * Parse an RSS 2.0 or Atom feed.
 *
 * Hand-rolled rather than pulling `rss-parser`, which ocean used through kotlin interop: that
 * package targets node's http stack and was only reaching cloud as an undeclared transitive of
 * ocean. Feed markup is regular enough that tag extraction is sufficient here.
 *
 * @param xml raw feed body
 * @param feedUrl url the feed came from, used for the favicon and home link
 */
export function parseFeed(xml: string, feedUrl: string): Page[] {
	const channelTitle = xmlTag(xml, 'title') ?? 'RSS Feed';
	const origin = (() => {
		try {
			return new URL(feedUrl).origin;
		} catch {
			return feedUrl;
		}
	})();
	const home = xmlTag(xml, 'link') ?? origin;
	const favicon = `${origin}/favicon.ico`;

	const entries = xml.match(/<(item|entry)[\s\S]*?<\/\1>/gi) ?? [];

	return entries.flatMap((entry) => {
		// atom puts the url in link/@href rather than in the element body
		const link =
			xmlTag(entry, 'link') ??
			/<link[^>]*href=["']([^"']+)["']/i.exec(entry)?.[1] ??
			xmlTag(entry, 'guid');
		const title = xmlTag(entry, 'title');
		if (!link || !title) return [];

		const summary = xmlTag(entry, 'description') ?? xmlTag(entry, 'summary') ?? '';
		const body = xmlTag(entry, 'content:encoded') ?? xmlTag(entry, 'content') ?? summary;

		return [
			{
				url: link,
				title: stripHtml(title),
				author: xmlTag(entry, 'dc:creator') ?? xmlTag(entry, 'author') ?? channelTitle,
				source: channelTitle,
				date: xmlTag(entry, 'pubDate') ?? xmlTag(entry, 'updated') ?? '',
				links: { Home: home },
				favicon,
				abstract: stripHtml(summary) || NO_ABSTRACT,
				content: stripHtml(body) || NO_CONTENT,
				theme_color: '#ffffff',
				keywords: []
			} satisfies Page
		];
	});
}

/**
 * Build an RSS-backed scraper. Matches ocean's behaviour: every whitespace-separated term must
 * appear in the title, abstract or content.
 *
 * @param label human name of the feed
 * @param url feed url
 */
export function rssScraper(label: string, url: string): Scraper {
	return {
		name: `RSS Feed [${label}]`,
		baseUrl: url,
		tags: [],
		async search(query, pageLimit) {
			const terms = query.split(' ').filter((t) => t.trim().length > 0);
			const pages = parseFeed(await fetchText(url), url);

			return pages
				.filter((page) =>
					terms.every((term) => {
						const needle = term.toLowerCase();
						return (
							page.title.toLowerCase().includes(needle) ||
							(page.abstract ?? '').toLowerCase().includes(needle) ||
							(page.content ?? '').toLowerCase().includes(needle)
						);
					})
				)
				.slice(0, Math.max(pageLimit, 0) || pages.length);
		}
	};
}

// #endregion

// #region doaj

type DoajArticle = {
	id: string;
	bibjson: {
		title?: string;
		abstract?: string;
		year?: string;
		month?: string;
		author?: { name?: string }[];
		keywords?: string[];
		link?: { type?: string; url?: string }[];
		journal?: { title?: string; volume?: string; number?: string; publisher?: string };
	};
};

const MONTHS: Record<string, string> = {
	'01': 'January',
	'02': 'February',
	'03': 'March',
	'04': 'April',
	'05': 'May',
	'06': 'June',
	'07': 'July',
	'08': 'August',
	'09': 'September',
	'10': 'October',
	'11': 'November',
	'12': 'December'
};

export const doajScraper: Scraper = {
	name: 'DOAJ',
	baseUrl: 'https://doaj.org/api/v4',
	tags: ['open-access', 'academic', 'research', 'journals', 'articles'],
	async search(query, pageLimit) {
		const out: Page[] = [];
		const total = Math.max(pageLimit, 1);

		for (let page = 1; page <= total; page++) {
			const url = `https://doaj.org/api/v4/search/articles/${encodeURIComponent(query)}?page=${page}&pageSize=${PER_PAGE}`;
			try {
				const body = JSON.parse(await fetchText(url)) as { results?: DoajArticle[] };
				for (const article of body.results ?? []) {
					const parsed = parseDoajArticle(article);
					if (parsed) out.push(parsed);
				}
			} catch {
				// one bad page must not lose the pages that did come back
				break;
			}
		}

		return out;
	}
};

function parseDoajArticle(article: DoajArticle): Page | null {
	const b = article.bibjson;
	if (!b?.title) return null;

	const abstract = b.abstract;
	if (!abstract || abstract.length < MIN_CONTENT_SIZE) return null;

	const url =
		b.link?.find((l) => l.type === 'fulltext')?.url ?? `https://doaj.org/article/${article.id}`;

	const source =
		[
			b.journal?.volume ? `Vol. ${b.journal.volume}` : null,
			b.journal?.number ? `Issue ${b.journal.number}` : null,
			b.journal?.title,
			b.journal?.publisher
		]
			.filter(Boolean)
			.join(', ') || 'Unknown Journal';

	const month = b.month ? MONTHS[b.month.padStart(2, '0')] : undefined;
	const date = [month, b.year].filter(Boolean).join(' ') || 'Unknown Date';

	return {
		url,
		title: b.title.trim(),
		author: formatAuthors((b.author ?? []).map((a) => a.name ?? '')),
		source,
		date,
		links: { DOAJ: `https://doaj.org/article/${article.id}` },
		favicon: 'https://doaj.org/favicon.ico',
		abstract: abstract.trim(),
		content: abstract.trim(),
		theme_color: '#ffffff',
		keywords: (b.keywords ?? []).map((k) => k.trim()).filter(Boolean)
	};
}

// #endregion

// #region pubmed

export const pubmedScraper: Scraper = {
	name: 'PubMed',
	baseUrl: 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils',
	tags: ['medicine', 'biology', 'health', 'research'],
	async search(query, pageLimit, keys) {
		const key = keys['PubMed'] ? `&api_key=${keys['PubMed']}` : '';
		const retmax = Math.max(pageLimit, 1) * 10;
		const searchUrl =
			`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed` +
			`&term=${encodeURIComponent(query)}&retmax=${retmax}&retmode=json${key}`;

		let ids: string[] = [];
		try {
			const body = JSON.parse(await fetchText(searchUrl)) as {
				esearchresult?: { idlist?: string[] };
			};
			ids = body.esearchresult?.idlist ?? [];
		} catch {
			return [];
		}

		const pages = await Promise.all(
			ids.map(async (pmid) => {
				const articleUrl = `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;
				try {
					const md = await fetchPageMetadata(articleUrl);
					const page = createArticle(articleUrl, md, {
						favicon: 'https://pubmed.ncbi.nlm.nih.gov/favicon.ico'
					});
					page.content = page.abstract ?? NO_CONTENT;
					return isUsablePage(page) && (page.content?.length ?? 0) >= MIN_CONTENT_SIZE
						? page
						: null;
				} catch {
					return null;
				}
			})
		);

		return pages.filter((p): p is Page => p !== null);
	}
};

// #endregion

// #region html journals

/**
 * A journal that has to be scraped from its search page rather than an API.
 *
 * @param name display name
 * @param baseUrl origin, used to resolve relative hrefs
 * @param searchUrl builds the listing url for a query
 * @param linkSelector css selector for article links on the listing page
 * @param contentSelector css selector for the article body
 * @param hostFilter only keep links on this host
 */
function htmlJournalScraper(
	name: string,
	baseUrl: string,
	searchUrl: (query: string) => string,
	linkSelector: string,
	contentSelector: string,
	hostFilter: string
): Scraper {
	return {
		name,
		baseUrl,
		tags: ['academic', 'research', 'journals'],
		async search(query, pageLimit) {
			let listing: PageMetadata;
			try {
				listing = await fetchPageMetadata(searchUrl(query), linkSelector);
			} catch {
				return [];
			}

			const urls = [
				...new Set(
					listing.links
						.map((href) => normalizeLink(baseUrl, href))
						.filter((u): u is string => !!u && u.includes(hostFilter))
				)
			].slice(0, Math.max(pageLimit, 1) * 10);

			const pages = await Promise.all(
				urls.map(async (articleUrl) => {
					try {
						const md = await fetchPageMetadata(articleUrl, undefined, contentSelector);
						if (md.sectionText.length < MIN_CONTENT_SIZE) return null;

						const page = createArticle(articleUrl, md, { content: md.sectionText });
						return isUsablePage(page) ? page : null;
					} catch {
						return null;
					}
				})
			);

			return pages.filter((p): p is Page => p !== null);
		}
	};
}

export const springerOpenScraper = htmlJournalScraper(
	'SpringerOpen',
	'https://link.springer.com',
	(q) =>
		`https://link.springer.com/search?query=${encodeURIComponent(q).replace(/%20/g, '+')}` +
		`&sortBy=newestFirst&openAccess=true&content-type=Article&date=m12`,
	'div.app-card-open__main > h3.app-card-open__heading > a.app-card-open__link',
	'main > article > section',
	'springeropen.com'
);

export const imejScraper = htmlJournalScraper(
	'IMEJ',
	'https://marineenergyjournal.org',
	(q) => `https://marineenergyjournal.org/search?q=${encodeURIComponent(q)}`,
	'a.article-title, h3 > a',
	'main article, div.article-content',
	'marineenergyjournal.org'
);

// #endregion

// #region registry

/** the same sources, in the same order, that ocean registered */
export const REGISTERED_SCRAPERS: readonly Scraper[] = [
	pubmedScraper,
	imejScraper,
	springerOpenScraper,
	doajScraper,
	// science
	rssScraper(
		'New Scientist Magazine',
		'https://www.newscientist.com/feed/home/?cmpid=RSS%7CNSNS-Home'
	),
	rssScraper('Space.com', 'https://www.space.com/feeds.xml'),
	// psychology
	rssScraper('School of Psychology', 'https://blogs.sussex.ac.uk/psychology/feed/'),
	// tech
	rssScraper('MIT News', 'https://news.mit.edu/rss/topic/artificial-intelligence2'),
	// art
	rssScraper('Art News', 'https://www.artnews.com/feed/'),
	rssScraper('This is Colossal', 'https://www.thisiscolossal.com/feed/'),
	rssScraper('Canvas', 'https://canvas.saatchiart.com/feed'),
	// environment
	rssScraper('Grist', 'https://grist.org/feed/'),
	rssScraper('Earth 991', 'https://earth911.com/feed/'),
	rssScraper('Earth University @ Columbia', 'https://news.climate.columbia.edu/feed/'),
	rssScraper('EcoWatch', 'https://www.ecowatch.com/energy-news/feed')
];

/**
 * Query every registered source and return distinct pages.
 *
 * A source that throws is skipped, exactly as ocean's `searchAll` swallowed IOException -- one dead
 * feed must not fail the whole run.
 *
 * @param query search terms
 * @param pageLimit pages to take from each source
 * @param keys api keys by scraper name
 */
export async function searchAll(
	query: string,
	pageLimit: number = 5,
	keys: ApiKeys = {}
): Promise<Page[]> {
	const results = await Promise.allSettled(
		REGISTERED_SCRAPERS.map((s) => s.search(query, pageLimit, keys))
	);

	const seen = new Set<string>();
	const out: Page[] = [];
	for (const result of results) {
		if (result.status !== 'fulfilled') continue;
		for (const page of result.value) {
			if (!page.url || seen.has(page.url)) continue;
			seen.add(page.url);
			out.push(page);
		}
	}

	return out;
}

// #endregion
