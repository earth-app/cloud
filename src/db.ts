import { D1Database } from "@cloudflare/workers-types";
import { ActivityData } from "./types";

async function checkActivityTable(d1: D1Database) {
    const query = `CREATE TABLE IF NOT EXISTS activities (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        name TEXT NOT NULL UNIQUE,
        human_name TEXT NOT NULL,
        description TEXT NOT NULL,
        aliases TEXT,
        types TEXT NOT NULL,
        icon BLOB NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`;
    await d1.prepare(query).run();

    // Indexes for performance
    const nameIndexQuery = `CREATE UNIQUE INDEX IF NOT EXISTS idx_activities_name ON activities (name)`;
    await d1.prepare(nameIndexQuery).run();
}

export async function getActivity(d1: D1Database, name: string): Promise<ActivityData | null> {
    await checkActivityTable(d1);

    const query = `SELECT * FROM activities WHERE name = ?`;
    
    return await d1.prepare(query)
        .bind(name)
        .first<ActivityData>();
}

export async function setActivity(d1: D1Database, activity: ActivityData) {
    await checkActivityTable(d1);

    const existing = await getActivity(d1, activity.name);
    if (existing) {
        // Update existing activity
        const query = `UPDATE activities SET description = ?, aliases = ?, types = ?, icon = ?, updated_at = CURRENT_TIMESTAMP WHERE name = ?`;
        await d1.prepare(query)
            .bind(activity.description, activity.aliases, activity.types, activity.icon, activity.name)
            .run();
        return;
    } else {
        const query = `INSERT INTO activities (name, human_name, description, aliases, types, icon) VALUES (?, ?, ?, ?, ?, ?)`;
        await d1.prepare(query)
            .bind(activity.name, activity.human_name, activity.description, activity.aliases, activity.types, activity.icon)
            .run();
    }
}