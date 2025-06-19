import { D1Database } from "@cloudflare/workers-types";
import { ActivityData } from "./types";

async function checkActivityTable(d1: D1Database) {
    const query = `CREATE TABLE IF NOT EXISTS activities (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        name TEXT NOT NULL, 
        description TEXT NOT NULL, 
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

    const query = `INSERT INTO activities (name, description, icon) VALUES (?, ?, ?)`;
    await d1.prepare(query)
        .bind(activity.name, activity.description, activity.icon)
        .run();
}