import { QuestStep } from '.';
import { classifyImage, detectObjects, scoreAudio, scoreImage } from '../../content/ferry';
import ExifReader from 'exifreader';
import { parseBuffer } from 'music-metadata';
import { isInsideLocation } from '../../util/util';
import { Bindings } from '../../util/types';
import { QuestStepResponse } from './tracking';

export type QuestDeviceMetadata = {
	latitude?: number;
	longitude?: number;
	make:
		| 'apple'
		| 'samsung'
		| 'google'
		| 'oneplus'
		| 'huawei'
		| 'xiaomi'
		| 'lg'
		| 'motorola'
		| 'sony'
		| 'nokia'
		| 'microsoft'
		| 'linux'
		| 'android'
		| 'unknown'
		| string;
	model: 'iPhone' | 'iPad' | 'Mac' | 'Android' | 'PC' | 'Desktop' | 'unknown' | string;
	os: 'ios' | 'android' | 'windows' | 'macos' | 'linux' | 'unknown' | string;
	version?: string;
	[other: string]: any; // allow for additional metadata fields as needed
};

// Helper to extract major version number from version strings
function extractMajorVersion(versionStr: string | undefined): string | null {
	if (!versionStr) return null;
	const match = versionStr.match(/\b(\d+)(?:\.\d+)*/);
	return match ? match[1] : null;
}

// Detect Virtual Camera / Screen Capture / Photo Editing Software
function detectNonCameraSoftware(softwareRaw: string | undefined): string | null {
	if (!softwareRaw) return null;

	const software = softwareRaw.toLowerCase();
	const screenCapture =
		/\bobs\s*studio\b|screenflow|camtasia|sharex|screentoaster|bandicam|action\s*cam|fraps|plays\.tv|nvidia\s*share|xbox\s*game\s*bar/i.test(
			software
		);
	if (screenCapture) return 'Screen capture software detected';

	const photoEditor =
		/\badobe\s*photoshop\b|lightroom|gimp|snapseed|pixlr|photopea|krita|affinity\s*photo|capture\s*one|darktable|rawtherapee/i.test(
			software
		);
	if (photoEditor) return 'Photo editing software detected';
	const rendering =
		/\bblender\b|cinema\s*4d|3ds\s*max|maya\b|houdini|unreal\s*engine|unity\b|godot|substance\s*painter/i.test(
			software
		);
	if (rendering) return '3D rendering software detected';
	const online =
		/\bimgur\b|imgur\s*editor|photoshop\s*online|pixlr\s*editor|pixlr\s*express|canva|procreate|photopea|befunky/i.test(
			software
		);
	if (online) return 'Online editor detected';

	const aiGenerated = /\bdalle\b|stable\s*diffusion|midjourney|diffusion|texttoimage|txt2img/i.test(
		software
	);
	if (aiGenerated) return 'AI image generation detected';

	return null;
}

// main validation function

export async function validateStep(
	step: QuestStep,
	response: QuestStepResponse,
	bindings: Bindings,
	data: QuestDeviceMetadata
): Promise<{ success: boolean; message?: string }> {
	if (step.type !== response.type) {
		return { success: false, message: `Expected response type ${step.type}, got ${response.type}` };
	}

	switch (response.type) {
		case 'take_photo_location':
		case 'take_photo_classification':
		case 'take_photo_caption':
		case 'draw_picture':
		case 'take_photo_objects': {
			if (!response.data) {
				return { success: false, message: 'No photo data provided in response.' };
			}

			return await validateStepPhoto(step, response.data, bindings, data);
		}
		case 'transcribe_audio': {
			if (!response.data) {
				return { success: false, message: 'No audio data provided in response.' };
			}

			return await validateStepAudio(step, response.data, bindings, data);
		}
		case 'article_quiz': {
			return await validateArticleQuiz(step, response, bindings);
		}
	}

	return { success: true }; // attend_event, match_terms, order_items are validated externally
}

// validation functions

async function validateArticleQuiz(
	step: QuestStep,
	response: QuestStepResponse & { type: 'article_quiz' },
	bindings: Bindings
) {
	if (step.type !== 'article_quiz') {
		return { success: false, message: `Expected article_quiz step, got ${step.type}` };
	}

	// look up the persisted quiz score from kv to avoid trusting the client
	const quizData = await bindings.KV.get<{
		score: number;
		scorePercent: number;
		total: number;
	}>(response.scoreKey, 'json');

	if (!quizData) {
		return {
			success: false,
			message: 'Quiz score not found. Please complete the article quiz first.'
		};
	}

	const [, threshold] = step.parameters;
	const requiredPercent = threshold * 100;

	if (quizData.scorePercent < requiredPercent) {
		return {
			success: false,
			message: `Quiz score ${quizData.scorePercent.toFixed(1)}% does not meet the required ${requiredPercent}%.`
		};
	}

	return { success: true };
}

async function validateStepAudio(
	step: QuestStep,
	audio: Uint8Array,
	bindings: Bindings,
	data: QuestDeviceMetadata
) {
	if (step.type !== 'transcribe_audio') {
		return {
			success: false,
			message: `Expected audio response for transcribe_audio step, got ${step.type}`
		};
	}

	// music-metadata validation — authenticate the recording to the claimed device/OS.
	try {
		const audioMeta = await parseBuffer(audio);
		const { common, format, native } = audioMeta;

		const encodedBy = (common.encodedby ?? '').toLowerCase();
		const encoderSettings = (common.encodersettings ?? '').toLowerCase();
		const container = (format.container ?? '').toLowerCase();
		const codec = (format.codec ?? '').toLowerCase();

		// IComment[] always has a .text property
		const comment = (common.comment ?? [])
			.map((c) => c.text ?? '')
			.join(' ')
			.toLowerCase();

		// flatten raw/native tags into one searchable string
		const nativeSignal = Object.values(native ?? {})
			.flat()
			.map((t) => `${String(t?.id ?? '')}=${String(t?.value ?? '')}`)
			.join(' ')
			.toLowerCase();

		const allSignals = `${encodedBy} ${encoderSettings} ${container} ${codec} ${comment} ${nativeSignal}`;

		// Hard, unambiguous container/codec constraints:
		// CAF (Core Audio Format) is an Apple-exclusive container
		const isAppleExclusiveContainer = container === 'caf';
		// AMR/AMR-WB are almost exclusively produced by Android voice recorders
		const isAndroidCodec = codec === 'amr' || codec === 'amr-wb';

		// Soft encoder signal detection — only act when the positive signal for the
		// OTHER platform is present AND there is no countering signal for the claimed one
		const hasAppleEncoderSignal = /com\.apple|voice\s*memos|apple\s*voice|iphone|ipad/i.test(
			allSignals
		);
		const hasAndroidEncoderSignal =
			/\bandroid\b|samsung\s*voice\s*recorder|google\s*recorder|oneplus|huawei|xiaomi|lg|motorola|sony|nokia/i.test(
				allSignals
			);

		const os = data.os?.toLowerCase()?.trim() ?? '';
		const makeIsApple = data.make?.toLowerCase()?.trim() === 'apple';

		if (os === 'ios' || makeIsApple) {
			// AMR is Android-only hardware codec - no iOS device has ever produced it
			if (isAndroidCodec) {
				return {
					success: false,
					message: 'AMR audio codec is exclusively produced by Android voice recorders, not iOS.'
				};
			}

			if (hasAndroidEncoderSignal && !hasAppleEncoderSignal) {
				return {
					success: false,
					message:
						'Audio encoder metadata indicates an Android device, which is inconsistent with the declared iOS device.'
				};
			}
		}

		if (os === 'android') {
			if (isAppleExclusiveContainer) {
				return {
					success: false,
					message:
						'CAF audio container is Apple-exclusive and incompatible with the declared Android device.'
				};
			}

			if (hasAppleEncoderSignal && !hasAndroidEncoderSignal) {
				return {
					success: false,
					message:
						'Audio encoder metadata indicates an Apple device, which is inconsistent with the declared Android device.'
				};
			}
		}

		if (os === 'windows' || os === 'linux') {
			if (isAppleExclusiveContainer) {
				return {
					success: false,
					message: `CAF audio container is Apple-exclusive and incompatible with declared ${data.os} device.`
				};
			}
			if (isAndroidCodec) {
				return {
					success: false,
					message: `AMR audio codec is exclusively produced by mobile voice recorders, not ${data.os}.`
				};
			}
		}

		// macOS: CAF is valid (QuickTime/GarageBand/Voice Memos produce it); no hard blocks apply
	} catch {
		// Metadata absent or unparseable — not itself suspicious for audio; proceed to AI scoring
	}

	const [prompt, threshold] = step.parameters;
	const [_, score] = await scoreAudio(bindings, audio, prompt, [
		{
			id: 'relevance',
			weight: 0.7,
			ideal: 'Audio is relevant to the prompt and demonstrates understanding'
		},
		{
			id: 'clarity',
			weight: 0.3,
			ideal: 'Audio is clear and intelligible'
		}
	]);

	if (score.score < threshold) {
		return {
			success: false,
			message: `Audio does not meet the required score threshold of ${threshold}. Got ${score.score}.`
		};
	}

	return { success: true };
}

async function validateStepPhoto(
	step: QuestStep,
	image: Uint8Array,
	bindings: Bindings,
	data: QuestDeviceMetadata
) {
	// EXIF parse failure is treated as a hard rejection — a missing or corrupt EXIF block
	// is a strong signal of tampering (re-encoding, screenshot, etc.)
	let metadata!: ExifReader.Tags;
	try {
		metadata = ExifReader.load(image.buffer as ArrayBuffer);
	} catch {
		return { success: false, message: 'Failed to parse photo EXIF metadata.' };
	}

	// Make is required: its absence indicates the image was not taken by a real camera app
	const makeRaw = metadata.Make?.value?.toString()?.trim();
	if (!makeRaw) {
		return { success: false, message: 'Photo is missing the required EXIF Make field.' };
	}
	const make = makeRaw.toLowerCase();

	// DateTimeOriginal is required: absence or unparseable value rejects the submission
	const dateRaw = metadata.DateTimeOriginal?.value?.toString()?.trim();
	if (!dateRaw) {
		return {
			success: false,
			message: 'Photo is missing the required EXIF DateTimeOriginal field.'
		};
	}
	// EXIF format: "YYYY:MM:DD HH:MM:SS" — normalise separator to ISO-8601 for Date parsing
	const dateTaken = new Date(dateRaw.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3')).getTime();
	if (!Number.isFinite(dateTaken)) {
		return { success: false, message: 'Photo has an unparseable EXIF DateTimeOriginal value.' };
	}

	// OffsetTimeOriginal is optional; default to UTC (0) if absent or malformed.
	// Minutes always adopt the sign of hours so that zones like -05:30 are handled correctly.
	const offsetRaw = metadata.OffsetTimeOriginal?.value?.toString()?.trim() ?? null;
	let offsetMs = 0;
	if (offsetRaw) {
		const parts = offsetRaw.split(':').map(Number);
		if (parts.length >= 2 && parts.every(Number.isFinite)) {
			offsetMs = (parts[0] * 60 + Math.sign(parts[0]) * Math.abs(parts[1])) * 60 * 1000;
		}
	}

	// Allow 5-minute clock skew
	const now = Date.now();
	if (Math.abs(now - dateTaken + offsetMs) > 5 * 60 * 1000) {
		return {
			success: false,
			message:
				'Photo timestamp is not within the acceptable range (possible clock skew or old photo).'
		};
	}

	const softwareRaw = metadata.Software?.value?.toString()?.trim() ?? '';
	const nonCameraReason = detectNonCameraSoftware(softwareRaw);
	if (nonCameraReason) {
		return {
			success: false,
			message: `${nonCameraReason}: "${softwareRaw}".`
		};
	}

	// focal length of 0 is physically impossible in real cameras
	const focalLength = metadata.FocalLength?.value;
	if (focalLength != null && Number(focalLength) === 0) {
		return {
			success: false,
			message: 'Photo has invalid focal length (0), indicating a virtual or manipulated image.'
		};
	}

	// DateTime Digitized should match Original; large gaps indicate editing/conversion
	const dateDigitized = metadata.DateTimeDigitized?.value?.toString()?.trim();
	if (dateDigitized && dateRaw && dateDigitized !== dateRaw) {
		// Parse the digitized date
		const digitizedTime = new Date(
			dateDigitized.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3')
		).getTime();

		if (Number.isFinite(digitizedTime)) {
			// Allow 1 second of difference (clock sync variations), but flag larger gaps
			const timeDiff = Math.abs(dateTaken - digitizedTime);
			if (timeDiff > 1000) {
				return {
					success: false,
					message: `DateTime Original and DateTime Digitized mismatch (${(timeDiff / 1000).toFixed(0)}s apart), indicating post-processing.`
				};
			}
		}
	}

	const hasAperture = metadata.ApertureValue != null || metadata.FNumber != null;
	const hasLens = metadata.LensModel != null;
	const hasExposure = metadata.ExposureTime != null;
	const isSuspiciouslyBare = !hasLens && !hasAperture && !hasExposure;
	if (isSuspiciouslyBare && make) {
		return {
			success: false,
			message:
				'Photo is missing critical camera EXIF fields (aperture, lens, exposure), indicating a synthetic or heavily manipulated image.'
		};
	}

	// Make cross-check: accept if either string contains the other to handle verbose OEM strings
	// e.g. "SAMSUNG ELECTRONICS" still matches declared "samsung"
	if (data.make && data.make !== 'unknown') {
		const expectedMake = data.make.toLowerCase().trim();
		if (!make.includes(expectedMake) && !expectedMake.includes(make)) {
			return {
				success: false,
				message: `Expected device make "${data.make}", but EXIF reports "${makeRaw}".`
			};
		}
	}

	// model cross-check: normalise aggressively since OEM model strings vary wildly in punctuation
	const modelRaw = metadata.Model?.value?.toString()?.trim();
	if (modelRaw && data.model && data.model !== 'unknown') {
		const normalise = (s: string) =>
			s
				.toLowerCase()
				.trim()
				.replace(/[^a-z0-9-]/g, '');
		const expectedModel = normalise(data.model);
		const actualModel = normalise(modelRaw);
		if (
			expectedModel &&
			actualModel &&
			!actualModel.includes(expectedModel) &&
			!expectedModel.includes(actualModel)
		) {
			return {
				success: false,
				message: `Expected device model "${data.model}", but EXIF reports "${modelRaw}".`
			};
		}
	}

	// OS cross-validation
	const os = data.os?.toLowerCase()?.trim() ?? '';
	if (os && os !== 'unknown') {
		const makeNorm = make.toLowerCase().trim();

		// Hard constraint: OS ↔ Make mapping is strictly enforced
		// iOS/iPadOS run exclusively on Apple hardware
		if (os === 'ios') {
			if (!makeNorm.includes('apple')) {
				return {
					success: false,
					message: `iOS requires Apple hardware, but EXIF Make is "${makeRaw}".`
				};
			}
		}
		// macOS runs exclusively on Apple hardware
		else if (os === 'macos') {
			if (!makeNorm.includes('apple')) {
				return {
					success: false,
					message: `macOS requires Apple hardware, but EXIF Make is "${makeRaw}".`
				};
			}
		}
		// Android runs on any non-Apple hardware
		else if (os === 'android') {
			if (makeNorm.includes('apple')) {
				return {
					success: false,
					message: `Android cannot run on Apple hardware, but EXIF Make is "${makeRaw}".`
				};
			}
		}
		// Windows runs on desktop hardware (typically Microsoft, Intel, AMD), not mobile
		else if (os === 'windows') {
			if (makeNorm.includes('apple')) {
				return {
					success: false,
					message: `Windows cannot run on Apple hardware, but EXIF Make is "${makeRaw}".`
				};
			}
		}

		const modelNorm = modelRaw?.toLowerCase().trim() ?? '';
		if (modelNorm) {
			const isIphoneIpad = modelNorm.includes('iphone') || modelNorm.includes('ipad');
			const isAndroidModel =
				/^(sm-|pixel|oneplus|huawei|mi|redmi|poco|lg-|moto|xperia|nokia|android)/i.test(modelNorm);
			const isMac = modelNorm.includes('mac') && !modelNorm.includes('apple');
			const isPC = modelNorm.includes('pc') || modelNorm === 'desktop';

			// iPhone/iPad should only be with iOS
			if (isIphoneIpad && os !== 'ios') {
				return {
					success: false,
					message: `Model "${modelRaw}" is iOS-only, but declared OS is "${data.os}".`
				};
			}

			// Android-pattern models should only be with Android
			if (isAndroidModel && os !== 'android') {
				return {
					success: false,
					message: `Model "${modelRaw}" is Android-only, but declared OS is "${data.os}".`
				};
			}

			// Mac should only be with macOS
			if (isMac && os !== 'macos') {
				return {
					success: false,
					message: `Model "${modelRaw}" indicates macOS, but declared OS is "${data.os}".`
				};
			}

			// PC/Desktop should be with Windows/Linux, not mobile
			if (isPC && (os === 'ios' || os === 'android')) {
				return {
					success: false,
					message: `Model "${modelRaw}" is desktop-only, but declared OS is "${data.os}".`
				};
			}
		}

		// Soft constraint: EXIF Software field — only reject on unambiguous OS contradictions.
		// Many apps write their own name or a bare version string here, so patterns must be precise.
		if (softwareRaw) {
			const indicatesIos = /\biphone\s*os\b|\bipad\s*os\b/i.test(softwareRaw);
			const indicatesAndroid = /\bandroid\b/i.test(softwareRaw);
			const indicatesWindows = /\bwindows\b/i.test(softwareRaw);
			const indicatesMacOs = /\bmacos\b|\bmac\s*os\s*x\b/i.test(softwareRaw);
			const indicatesLinux = /\blinux\b/i.test(softwareRaw);

			// iOS typically writes a bare version string (e.g. "17.2.1") — only reject on explicit mismatch
			const softwareMismatch =
				(os === 'ios' &&
					(indicatesAndroid || indicatesWindows || indicatesMacOs || indicatesLinux)) ||
				(os === 'android' && (indicatesIos || indicatesMacOs || indicatesWindows)) ||
				(os === 'windows' &&
					(indicatesIos || indicatesAndroid || indicatesMacOs || indicatesLinux)) ||
				(os === 'macos' && (indicatesAndroid || indicatesWindows || indicatesLinux)) ||
				(os === 'linux' && (indicatesIos || indicatesMacOs || indicatesWindows));

			if (softwareMismatch) {
				return {
					success: false,
					message: `EXIF Software field "${softwareRaw}" is inconsistent with declared OS "${data.os}".`
				};
			}

			// Soft constraint: OS version validation
			// Extract version from Software field and compare against declared version
			if (data.version) {
				const declaredMajor = extractMajorVersion(data.version);
				const softwareMajor = extractMajorVersion(softwareRaw);

				// Only reject on clear major version mismatch (not nil/ambiguous cases)
				if (declaredMajor && softwareMajor && declaredMajor !== softwareMajor) {
					// Allow 1-version tolerance (common for photos from older devices or timing skew)
					const declaredNum = Number(declaredMajor);
					const softwareNum = Number(softwareMajor);
					if (Math.abs(declaredNum - softwareNum) > 1) {
						return {
							success: false,
							message: `OS version mismatch: declared ${data.version}, but EXIF Software indicates version ${softwareMajor}.`
						};
					}
				}
			}
		}
	}

	// type-based validation
	if (step.type === 'take_photo_location' || step.type === 'take_photo_classification') {
		let label: string | undefined;
		let score: number | undefined;
		if (step.type === 'take_photo_location') {
			// validate both device GPS data and photo EXIF GPS data
			const [lat, lng, radius, label0, score0] = step.parameters;

			if (data.latitude == null || data.longitude == null) {
				return {
					success: false,
					message: 'No GPS data provided in device metadata.'
				};
			}

			if (!isInsideLocation([data.latitude, data.longitude], [lat, lng], radius)) {
				return {
					success: false,
					message: 'Device was not within the required location radius when photo was taken.'
				};
			}

			// Use null checks rather than falsy so coords at 0 (equator/prime meridian) are valid
			const latStr = metadata.GPSLatitude?.value?.toString();
			const lngStr = metadata.GPSLongitude?.value?.toString();
			if (latStr == null || lngStr == null) {
				return { success: false, message: 'No GPS data found in photo EXIF metadata.' };
			}
			const latitude = Number(latStr);
			const longitude = Number(lngStr);
			if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
				return { success: false, message: 'Invalid GPS coordinates in photo EXIF metadata.' };
			}

			if (!isInsideLocation([latitude, longitude], [lat, lng], radius)) {
				return {
					success: false,
					message: 'Photo was not taken within the required location radius.'
				};
			}

			label = label0;
			score = score0;
		}

		if (step.type === 'take_photo_classification') {
			const [label0, score0] = step.parameters;
			label = label0;
			score = score0;
		}

		if (label && score) {
			const classifications = await classifyImage(bindings, image);
			const classification = classifications.find((c) => c.label === label);

			if (!classification || classification.confidence < score) {
				return {
					success: false,
					message: `Photo does not meet the required classification label "${label}" with confidence ${score}.`
				};
			}
		}
	}

	if (step.type === 'take_photo_objects') {
		const labelsAndScores = step.parameters;
		const detections = await detectObjects(bindings, image);

		for (const [label, score] of labelsAndScores) {
			const detection = detections.find(
				(d) =>
					d.label.toLowerCase().replace(/\s+/g, '_') === label.toLowerCase().replace(/\s+/g, '_')
			);
			if (!detection || detection.confidence < score) {
				return {
					success: false,
					message: `Photo does not contain the required object "${label}" with confidence ${score}.`
				};
			}
		}
	}

	if (step.type === 'take_photo_caption') {
		const [criteria, prompt, threshold] = step.parameters;
		const [_, score] = await scoreImage(bindings, image, prompt, criteria);
		if (score.score < threshold) {
			return {
				success: false,
				message: `Photo caption does not meet the required score threshold of ${threshold}. Got ${score.score}.`
			};
		}
	}

	if (step.type === 'draw_picture') {
		const [prompt, threshold] = step.parameters;

		// ask the model to describe what is drawn so we can score accuracy against the prompt
		const captionPrompt = 'Describe the main object or subject that is drawn in this image.';
		const [_, score] = await scoreImage(bindings, image, captionPrompt, [
			{
				id: 'accuracy',
				weight: 0.7,
				ideal: `The image clearly shows a drawing of a ${prompt}`
			},
			{
				id: 'effort',
				weight: 0.3,
				ideal: 'The drawing shows recognizable detail and clear intent in depicting the subject'
			}
		]);
		if (score.score < threshold) {
			return {
				success: false,
				message: `Drawing does not meet the required score threshold of ${threshold}. Got ${score.score.toFixed(2)}.`
			};
		}
	}

	return { success: true };
}
