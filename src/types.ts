import { Ai, D1Database, Fetcher } from "@cloudflare/workers-types"

export type Bindings = {
    DB: D1Database,
    AI: Ai,
    ASSETS: Fetcher
}

export type ActivityData = {
    id: number,
    name: string,
    description: string,
    icon: Uint8Array,
    data_url: string,
    created_at: string,
    updated_at?: string
}