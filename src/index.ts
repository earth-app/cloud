import { Hono } from "hono";

import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { cache } from 'hono/cache';
import { secureHeaders } from 'hono/secure-headers'

import * as packageJson from '../package.json'
import { activityDescriptionPrompt, activityDescriptionSystemMessage, activityImagePrompt } from "./prompts";
import { Bindings } from "./types";
import { getActivity, setActivity } from "./db";

const app = new Hono<{ Bindings: Bindings }>();

// Middleware

app.use(secureHeaders()) // Secure headers middleware
app.use(logger()) // Logger middleware
app.use(cors({ // CORS middleware
    origin: '*',
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    maxAge: 3600,
}))
app.use((c, next) => {
    c.res.headers.set('X-Earth-App-Version', packageJson.version)
    c.res.headers.set('X-Earth-App-Name', packageJson.name)

    return next()
}) // Custom headers middleware
app.use('*', cache({ // Cache middleware
    cacheName: 'earth-app-cache',
    cacheControl: 'public, max-age=60, s-maxage=60',
    vary: ['Accept-Encoding', 'Authorization'],
}))

// Implementation
app.get('/', (c) => c.text('Woosh!'))

app.get('/activity/:id', async (c) => {
    const id = c.req.param('id').toLowerCase();
    if (!id) {
        return c.text('Activity ID is required', 400);
    }

    const activity = await getActivity(c.env.DB, id);
    if (activity)
        return c.json(activity, 200)
    
    // Create new activity
    const description = await c.env.AI.run("@cf/meta/llama-3.2-1b-instruct", { messages: [
        { role: "system", content: activityDescriptionSystemMessage.trim() },
        { role: "user", content: activityDescriptionPrompt(id).trim()}
    ]})
    const desc = description?.response?.trim() || `No description available for ${id}.`;
    const trimmedDesc = desc.length > 500 ? desc.slice(0, 500) + '...' : desc;

    const image = await c.env.AI.run("@cf/black-forest-labs/flux-1-schnell", {
        prompt: activityImagePrompt(id, trimmedDesc).trim(),
        seed: Math.floor(Math.random() * 1000000)
    })

    const imgString = atob(image?.image || '')
    const img = Uint8Array.from(imgString, c => c.charCodeAt(0));

    const activityData = {
        id: 0, // Will be auto-incremented by the database
        name: id,
        description: desc,
        icon: img,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
    };

    await setActivity(c.env.DB, activityData);
    return c.json(activityData, 201);
})

app.get('/activity/:id/icon', async (c) => {
    const id = c.req.param('id').toLowerCase();
    if (!id) {
        return c.text('Activity ID is required', 400);
    }

    const activity = await getActivity(c.env.DB, id);
    if (!activity) {
        return c.text(`Activity ${id} not found`, 404);
    }

    const icon = activity.icon;
    if (!icon) {
        return c.text(`Icon for activity ${id} not found`, 404);
    }

    return c.body(icon, 200, {
        'Content-Type': 'image/jpeg',
        'Content-Length': icon.length.toString(),
    })
})

export default app;