import { com } from "@earth-app/ocean";
import { Context } from "hono";

export type Article = {
    title: string;
    author: string;
    source: string;
    url: string;
    abstract: string;
    content: string;
    theme_color: string;
    keywords: string[];
    date: string;
    favicon: string;
    links: {
        [key: string]: string;
    }
}

export async function findArticles(query: string, c: Context, limit: number = 3) {
    com.earthapp.ocean.boat.Scraper.setApiKey("PubMed", c.env.NCBI_API_KEY);

    const res = await com.earthapp.ocean.boat.searchAllAsPromise(com.earthapp.ocean.boat.Scraper.Companion, query, limit);
    const results = res.asJsReadonlyArrayView().map(async (item) => JSON.parse(item.toJson()))

    return await Promise.all(results)
}