import { UserProfilePromptData, generateProfilePhoto } from '../util/ai';
import { Bindings, ExecutionCtxLike } from '../util/types';
import { streamToUint8Array } from '../util/util';

export type ImageSizes = 32 | 128 | 1024 | null;
export const validSizes = [32, 128, 1024, null];

export async function getProfilePhoto(id: bigint, bindings: Bindings): Promise<Uint8Array> {
	if (id === 1n) {
		const resp = await bindings.ASSETS.fetch('https://assets.local/cloud.png');
		const fallback = await resp!.arrayBuffer();
		return new Uint8Array(fallback);
	}

	const profileImage = `users/${id}/profile.png`;

	const obj = await bindings.R2.get(profileImage);
	if (obj) {
		const buf = await obj.arrayBuffer();
		return new Uint8Array(buf);
	}

	const resp = await bindings.ASSETS.fetch('https://assets.local/earth-app.png');
	const fallback = await resp!.arrayBuffer();
	return new Uint8Array(fallback);
}
// sdxl-lightning occasionally returns truncated/blank output; anything under 1KB is almost certainly corrupt
const MIN_PROFILE_BYTES = 1024;

export async function newProfilePhoto(
	data: UserProfilePromptData,
	id: bigint,
	bindings: Bindings,
	ctx: ExecutionCtxLike
) {
	const profileImage = `users/${id}/profile.png`;

	let profile: Uint8Array;
	try {
		profile = await generateProfilePhoto(data, bindings.AI);
	} catch (err) {
		// surface a clean message to mantle2 instead of a raw model error
		const detail = err instanceof Error ? err.message : String(err);
		throw new Error(`Profile photo generation failed - ${detail}`);
	}

	if (!profile || profile.byteLength < MIN_PROFILE_BYTES) {
		throw new Error('Profile photo generation failed - model returned no data');
	}

	// put original image and schedule variations to be created in background
	ctx.waitUntil(
		Promise.all([
			bindings.R2.put(profileImage, profile, {
				httpMetadata: { contentType: 'image/png' }
			}),
			createPhotoVariation(128, profile, id, bindings, ctx),
			createPhotoVariation(32, profile, id, bindings, ctx)
		])
	);

	return profile;
}

export async function getProfileVariation(
	id: bigint,
	size: ImageSizes,
	bindings: Bindings,
	ctx: ExecutionCtxLike
) {
	if (id === 1n) {
		const resp = await bindings.ASSETS.fetch('https://assets.local/cloud.png');
		const fallback = await resp!.arrayBuffer();
		return new Uint8Array(fallback);
	}

	if (!size || size === 1024) return await getProfilePhoto(id, bindings); // original size requested
	if (!validSizes.includes(size)) return await getProfilePhoto(id, bindings); // fallback to original on invalid size

	const profileImage = `users/${id}/profile_${size}.png`;
	const obj = await bindings.R2.get(profileImage);

	if (obj) {
		const buf = await obj.arrayBuffer();
		return new Uint8Array(buf);
	} else {
		const profileImageOriginal = `users/${id}/profile.png`;
		const originalObj = await bindings.R2.get(profileImageOriginal);
		if (!originalObj) {
			const resp = await bindings.ASSETS.fetch('https://assets.local/earth-app.png');
			const fallback = await resp!.arrayBuffer();
			return new Uint8Array(fallback);
		}
		const buf = await originalObj.arrayBuffer();
		const profile = new Uint8Array(buf);

		return await createPhotoVariation(size, profile, id, bindings, ctx);
	}
}

export async function createPhotoVariation(
	size: ImageSizes,
	profile: Uint8Array,
	id: bigint,
	bindings: Bindings,
	ctx: ExecutionCtxLike
): Promise<Uint8Array> {
	if (!size || size === 1024) return await getProfilePhoto(id, bindings);

	// create stream from profile data
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(profile);
			controller.close();
		}
	});

	const profileImage = `users/${id}/profile_${size}.png`;
	const transformedStream = (
		await bindings.IMAGES.input(stream)
			.transform({ width: size, height: size })
			.output({ format: 'image/png' })
	).image();

	const transformedImage = await streamToUint8Array(transformedStream);

	ctx.waitUntil(
		bindings.R2.put(profileImage, transformedImage, {
			httpMetadata: { contentType: 'image/png' }
		})
	);

	return transformedImage;
}
