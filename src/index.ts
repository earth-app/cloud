import { Hono } from "hono";
import { inflate, deflate } from "pako";

import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { cache } from 'hono/cache';
import { secureHeaders } from 'hono/secure-headers'

import * as packageJson from '../package.json'
import { activityDescriptionPrompt, activityDescriptionSystemMessage, activityImagePrompt } from "./prompts";
import { Bindings } from "./types";
import { getActivity, setActivity } from "./db";
import { base64ToUint8Array, detectImageMime, uint8ArrayToBase64 } from "./compression";

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
    const id = c.req.param('id')?.toLowerCase();
    if (!id) {
        return c.text('Activity ID is required', 400);
    }

    // Try to fetch existing
    const existing = await getActivity(c.env.DB, id);
    if (existing) {
        let compressedBytes: Uint8Array;
        const stored: any = existing.icon;
        if (stored instanceof Uint8Array) {
            compressedBytes = stored;
        } else if (stored instanceof ArrayBuffer) {
            compressedBytes = new Uint8Array(stored);
        } else if (typeof stored === 'string') {
            const binary = atob(stored);
            const arr = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
                arr[i] = binary.charCodeAt(i);
            }
            compressedBytes = arr;
        } else {
            try {
               compressedBytes = new Uint8Array(stored);
            } catch {
                return c.text(`Stored icon format not recognized`, 500);
            }
        }

        let rawBytes: Uint8Array;
        try {
            rawBytes = inflate(compressedBytes);
        } catch (err) {
            return c.text(`Failed to decompress icon`, 500);
        }

        const mime = detectImageMime(rawBytes);
        const b64 = uint8ArrayToBase64(rawBytes);
        existing.data_url = `data:${mime};base64,${b64}`;

        return c.json(existing, 200);
    }

    // Generate description
    const description = await c.env.AI.run("@cf/meta/llama-3.2-1b-instruct", {
        messages: [
            { role: "system", content: activityDescriptionSystemMessage.trim() },
            { role: "user", content: activityDescriptionPrompt(id).trim() }
        ]
    });
    const descRaw = description?.response?.trim() || `No description available for ${id}.`;
    const trimmedDesc = descRaw.length > 500 ? descRaw.slice(0, 500) + '...' : descRaw;

    // Generate image
    const imageResult = await c.env.AI.run("@cf/black-forest-labs/flux-1-schnell", {
        prompt: activityImagePrompt(id, trimmedDesc).trim(),
        seed: Math.floor(Math.random() * 1000000)
    });
    const imgBase64 = imageResult?.image; // assume base64 string, e.g. "iVBORw0KGgoAAAANS..."
    if (!imgBase64) {
        return c.text(`Failed to generate image for activity '${id}'`, 500);
    }

    // Decode base64 to raw bytes
    let imgBytes: Uint8Array;
    try {
        imgBytes = base64ToUint8Array(imgBase64);
    } catch (err) {
        return c.text(`Failed to decode generated image data`, 500);
    }

    // Compress raw bytes
    let compressedImg: Uint8Array;
    try {
        compressedImg = deflate(imgBytes);
    } catch (err) {
        return c.text(`Failed to compress image`, 500);
    }

    const now = new Date().toISOString();
    const data_url = `data:image/png;base64,${imgBase64}`;

    const activityData = {
        id: 0, // Will be set by DB auto-increment
        name: id,
        description: descRaw,
        icon: compressedImg,
        data_url,
        created_at: now,
        updated_at: now
    };

    try {
        await setActivity(c.env.DB, activityData);
    } catch (err) {
        return c.text(`Failed to save activity`, 500);
    }

    return c.json(activityData, 201);
});

app.get('/activity/:id/icon', async (c) => {
    const id = c.req.param('id')?.toLowerCase();
    if (!id) {
        return c.text('Activity ID is required', 400);
    }

    const activity = await getActivity(c.env.DB, id);
    if (!activity) {
        return c.text(`Activity '${id}' not found`, 404);
    }

    const compressed: any = activity.icon;
    if (!compressed) {
        return c.text(`Icon for activity '${id}' not found`, 404);
    }

    let compressedBytes: Uint8Array;
    if (compressed instanceof Uint8Array) {
        compressedBytes = compressed;
    } else if (compressed instanceof ArrayBuffer) {
        compressedBytes = new Uint8Array(compressed);
    } else if (typeof compressed === 'string') {
        try {
            compressedBytes = base64ToUint8Array(compressed);
        } catch {
            return c.text(`Stored icon format not recognized`, 500);
        }
    } else {
        try {
            compressedBytes = new Uint8Array(compressed);
        } catch {
            return c.text(`Stored icon format not recognized`, 500);
        }
    }

    let imgBytes: Uint8Array;
    try {
        imgBytes = inflate(compressedBytes);
    } catch (err) {
        return c.text(`Failed to decompress icon`, 500);
    }

    // Serve raw bytes directly
    return c.body(imgBytes, 200, {
        'Content-Type': 'image/jpeg',
        'Content-Length': imgBytes.length.toString(),
        'Content-Disposition': `inline; filename="${id}-icon.jpg"`,
    });
});

export default app;