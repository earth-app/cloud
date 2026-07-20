import { QuestStep } from '.';
import { COCO_OBJECT_LABELS, IMAGENET_CLASSIFICATION_LABELS } from '../../util/ai';
import {
	classifyImage,
	detectObjects,
	scoreAudio,
	scoreImage,
	scoreText,
	type ScoreResult
} from '../../content/ferry';
import ExifReader from 'exifreader';
import { parseBuffer } from 'music-metadata';
import { isInsideLocation, normalizeId } from '../../util/util';
import { Bindings } from '../../util/types';
import { QuestStepResponse } from './tracking';
import { runAI, AITimeoutError } from '../../util/ai-runtime';
import { getNatureMinutesSince } from '../trails';
import { getUserTrailmarks } from '../trailmarks';

const USER_AGENT = '@earth-app/cloud v1.0 (support@earth-app.com)';

// hard cap so a cold workers-ai start can't stack past crust's timeout
const AI_VALIDATION_TIMEOUT_MS = 33000;

class AIValidationTimeoutError extends Error {
	constructor(public readonly kind: string) {
		super(`AI validation step "${kind}" timed out after ${AI_VALIDATION_TIMEOUT_MS}ms`);
		this.name = 'AIValidationTimeoutError';
	}
}

async function withAITimeout<T>(kind: string, fn: () => Promise<T>): Promise<T> {
	try {
		return await runAI(kind, fn, {
			attempts: 3,
			perAttemptTimeoutMs: AI_VALIDATION_TIMEOUT_MS / 3,
			totalTimeoutMs: AI_VALIDATION_TIMEOUT_MS,
			backoffMs: 150
		});
	} catch (err) {
		if (err instanceof AITimeoutError) throw new AIValidationTimeoutError(kind);
		throw err;
	}
}

// fail-safe result when AI scoring is exhausted: never auto-pass, never 500, never hang
function aiUnavailableResult(): { success: false; message: string } {
	return {
		success: false,
		message: 'Validation is temporarily unavailable. Please try again in a moment.'
	};
}

export const API_DEVICE_METADATA: QuestDeviceMetadata = {
	make: 'unknown',
	model: 'API',
	os: 'web'
};

// extra context for cloud-side accrual steps (nature_minutes / trailmarker_added): the user and
// the instant the current step first became achievable, so we only count what accrued since then
export type QuestValidationContext = {
	userId?: string;
	stepAchievableAt?: number;
};

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
	model: 'iPhone' | 'iPad' | 'Mac' | 'Android' | 'PC' | 'Desktop' | 'API' | 'unknown' | string;
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

function normalizeVisionLabel(label: string): string {
	return label.trim().toLowerCase().replace(/\s+/g, '_');
}

const VISION_LABEL_ALIASES: Record<string, string[]> = {
	// Common object/classification naming differences across model vocabularies.
	cell_phone: ['mobile_phone', 'smartphone', 'phone'],
	tv: ['television', 'monitor', 'screen'],
	bell_pepper: ['pepper'],
	spider_web: ['spiderweb'],
	corn: ['ear', 'ear_of_corn', 'corncob']
};

function expandVisionLabelCandidates(label: string): Set<string> {
	const normalized = normalizeVisionLabel(label);
	const candidates = new Set<string>([normalized]);

	const aliases = VISION_LABEL_ALIASES[normalized] || [];
	for (const alias of aliases) {
		candidates.add(normalizeVisionLabel(alias));
	}

	if (normalized.endsWith('s')) {
		candidates.add(normalized.slice(0, -1));
	} else {
		candidates.add(`${normalized}s`);
	}

	return candidates;
}

function findBestLabelConfidence(
	items: { label: string; confidence: number }[],
	requiredLabel: string
): { confidence: number } | null {
	const candidates = expandVisionLabelCandidates(requiredLabel);

	return items
		.filter((item) => candidates.has(normalizeVisionLabel(item.label)))
		.reduce<{
			confidence: number;
		} | null>(
			(best, item) => (best == null || item.confidence > best.confidence ? item : best),
			null
		);
}

export function normalizeThreshold(
	raw: unknown,
	context: string
): { ok: true; value: number } | { ok: false; message: string } {
	if (typeof raw !== 'number' || !Number.isFinite(raw)) {
		return { ok: false, message: `${context} threshold must be a finite number.` };
	}

	if (raw < 0) {
		return { ok: false, message: `${context} threshold must not be negative.` };
	}

	if (raw <= 1) {
		return { ok: true, value: raw };
	}

	if (raw <= 100) {
		return { ok: true, value: raw / 100 };
	}

	return {
		ok: false,
		message: `${context} threshold must be in the 0-1 range or 0-100 percentage range.`
	};
}

// barcodes

const RETAIL_FORMATS = new Set<number>([
	9, // EAN_13
	10, // EAN_8
	14, // UPC_A
	15 // UPC_E
]);

const VIN_FORMATS = new Set<number>([
	3, // CODE_39
	6, // DATA_MATRIX
	11 // PDF_417
]);

const BOARDING_PASS_FORMATS = new Set<number>([
	11, // PDF_417
	1, // AZTEC
	0, // QR_CODE
	6 // DATA_MATRIX
]);

type ResolvedKind = 'food' | 'music' | 'book' | 'beauty' | 'pet' | 'product' | 'vehicle' | 'flight';

export type BarcodeResolution = {
	kind: ResolvedKind;
	title: string;
	metadata: Record<string, unknown>;
};

const KIND_PRIORITY: ResolvedKind[] = ['book', 'food', 'music', 'beauty', 'pet', 'product'];
const KIND_FORMATS: Record<ResolvedKind, Set<number>> = {
	food: RETAIL_FORMATS,
	music: RETAIL_FORMATS,
	book: RETAIL_FORMATS,
	beauty: RETAIL_FORMATS,
	pet: RETAIL_FORMATS,
	product: RETAIL_FORMATS,
	vehicle: VIN_FORMATS,
	flight: BOARDING_PASS_FORMATS
};

const isIsbn = (value: string) => value.startsWith('978') || value.startsWith('979');

const OFF_DATABASES: { kind: ResolvedKind; host: string }[] = [
	{ kind: 'food', host: 'world.openfoodfacts.org' },
	{ kind: 'beauty', host: 'world.openbeautyfacts.org' },
	{ kind: 'pet', host: 'world.openpetfoodfacts.org' },
	{ kind: 'product', host: 'world.openproductsfacts.org' } // catch-all → ranked last
];

const OFF_FIELDS = 'product_name,brands,categories,quantity,ingredients_text,nutriments,image_url';

async function resolveOpenFacts(
	value: string,
	kind: ResolvedKind,
	host: string
): Promise<BarcodeResolution | null> {
	try {
		const res = await fetch(`https://${host}/api/v2/product/${value}.json?fields=${OFF_FIELDS}`, {
			headers: { 'User-Agent': USER_AGENT }
		});
		if (!res.ok) return null;
		const json = (await res.json()) as { product?: any };
		const product = json.product;
		if (!product?.product_name) return null;
		return {
			kind,
			title: String(product.product_name),
			metadata: {
				brands: product.brands,
				categories: product.categories,
				quantity: product.quantity,
				ingredients_text: product.ingredients_text,
				nutriments: product.nutriments,
				image_url: product.image_url
			}
		};
	} catch {
		return null;
	}
}

async function resolveBook(value: string): Promise<BarcodeResolution | null> {
	try {
		const res = await fetch(
			`https://openlibrary.org/api/books?bibkeys=ISBN:${value}&format=json&jscmd=data`
		);
		if (!res.ok) return null;
		const json = (await res.json()) as Record<string, any>;
		const book = json[`ISBN:${value}`];
		if (!book?.title) return null;
		return {
			kind: 'book',
			title: String(book.title),
			metadata: {
				authors: Array.isArray(book.authors)
					? book.authors.map((a: any) => a?.name).filter(Boolean)
					: [],
				publishers: Array.isArray(book.publishers)
					? book.publishers.map((p: any) => p?.name).filter(Boolean)
					: [],
				publish_date: book.publish_date,
				identifiers: book.identifiers,
				cover: book.cover,
				url: book.url
			}
		};
	} catch {
		return null;
	}
}

async function resolveMusic(value: string): Promise<BarcodeResolution | null> {
	try {
		const res = await fetch(
			`https://musicbrainz.org/ws/2/release?query=barcode:${value}&fmt=json`,
			{ headers: { 'User-Agent': USER_AGENT } }
		);
		if (!res.ok) return null;
		const json = (await res.json()) as { releases?: any[] };
		const release = json.releases?.[0];
		if (!release?.title) return null;
		return {
			kind: 'music',
			title: String(release.title),
			metadata: {
				artist: release['artist-credit']?.[0]?.name,
				year: typeof release.date === 'string' ? release.date.slice(0, 4) : undefined,
				country: release.country,
				mbid: release.id,
				label: release['label-info']?.[0]?.label?.name,
				track_count: release['track-count']
			}
		};
	} catch {
		return null;
	}
}

// VIN: 17 chars, excluding I/O/Q. Decoded for free by NHTSA's vPIC
// (US-market vehicles, model year 1981 and forward).
const VIN_REGEX = /^[A-HJ-NPR-Z0-9]{17}$/;

async function resolveVehicle(value: string): Promise<BarcodeResolution | null> {
	const vin = value.toUpperCase();
	if (!VIN_REGEX.test(vin)) return null;
	try {
		const res = await fetch(
			`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${vin}?format=json`
		);
		if (!res.ok) return null;
		const json = (await res.json()) as { Results?: any[] };
		const r = json.Results?.[0];
		if (!r) return null;
		const make = typeof r.Make === 'string' ? r.Make.trim() : '';
		const model = typeof r.Model === 'string' ? r.Model.trim() : '';
		const year = typeof r.ModelYear === 'string' ? r.ModelYear.trim() : '';
		if (!make && !model) return null; // vPIC returns blanks when it can't decode
		return {
			kind: 'vehicle',
			title: [year, make, model].filter(Boolean).join(' '),
			metadata: {
				make,
				model,
				year,
				vehicle_type: r.VehicleType,
				body_class: r.BodyClass,
				manufacturer: r.Manufacturer,
				plant_country: r.PlantCountry,
				fuel_type: r.FuelTypePrimary,
				doors: r.Doors,
				vin
			}
		};
	} catch {
		return null;
	}
}

// IATA BCBP (Resolution 792): the payload is fixed-width plaintext, so no API
// call is needed. We parse leg 1's mandatory fields and deliberately drop the
// passenger-name field (it's PII).
const BCBP_MIN_LENGTH = 60;

function parseBoardingPass(value: string): BarcodeResolution | null {
	if (value.charAt(0) !== 'M') return null; // format code
	if (!/[1-9]/.test(value.charAt(1))) return null; // number of legs encoded
	if (value.length < BCBP_MIN_LENGTH) return null;

	const pnr = value.substring(23, 30).trim();
	const from = value.substring(30, 33).trim().toUpperCase();
	const to = value.substring(33, 36).trim().toUpperCase();
	const carrier = value.substring(36, 39).trim().toUpperCase();
	const flightNumber = value.substring(39, 44).trim().replace(/^0+/, '');
	const julianDate = value.substring(44, 47).trim();
	const cabin = value.charAt(47);
	const seat = value.substring(48, 52).trim().replace(/^0+/, '');

	if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) return null;

	const flight = `${carrier}${flightNumber}`;
	return {
		kind: 'flight',
		title: `${flight} ${from} ${to}`,
		metadata: {
			carrier,
			flight_number: flightNumber,
			from, // IATA origin — enrich to a city/airport name via a local table
			to, // IATA destination
			cabin,
			seat,
			pnr,
			julian_date: julianDate
			// passenger name intentionally not captured
		}
	};
}

async function resolveBarcode(value: string, format: number): Promise<BarcodeResolution | null> {
	if (!RETAIL_FORMATS.has(format)) {
		const boardingPass = parseBoardingPass(value);
		if (boardingPass) return boardingPass;
		if (VIN_FORMATS.has(format)) return resolveVehicle(value);
		return null;
	}

	const attempts: Promise<BarcodeResolution | null>[] = [];
	if (isIsbn(value)) attempts.push(resolveBook(value));
	attempts.push(resolveMusic(value));
	for (const db of OFF_DATABASES) attempts.push(resolveOpenFacts(value, db.kind, db.host));

	const settled = await Promise.allSettled(attempts);
	const hits = settled
		.flatMap((s) => (s.status === 'fulfilled' && s.value ? [s.value] : []))
		.sort((a, b) => KIND_PRIORITY.indexOf(a.kind) - KIND_PRIORITY.indexOf(b.kind));

	return hits[0] ?? null;
}

async function validateScanBarcode(
	step: QuestStep,
	response: QuestStepResponse & { type: 'scan_barcode' }
): Promise<{
	success: boolean;
	message?: string;
	kind?: ResolvedKind;
	title?: string;
	metadata?: Record<string, unknown>;
}> {
	if (step.type !== 'scan_barcode') {
		return { success: false, message: `Expected scan_barcode step, got ${step.type}` };
	}

	const value = typeof response.data === 'string' ? response.data.trim() : '';
	if (!value) {
		return { success: false, message: 'Scan value is required.' };
	}
	if (typeof response.format !== 'number' || !Number.isFinite(response.format)) {
		return { success: false, message: 'Barcode format is required.' };
	}

	const [requiredKind, keyword] = step.parameters as [ResolvedKind, string | undefined];

	// Format gate is now per-kind: a "vehicle" target wants a VIN format, a
	// "flight" target wants a boarding-pass format, everything else wants retail.
	const allowedFormats = KIND_FORMATS[requiredKind];
	if (!allowedFormats || !allowedFormats.has(response.format)) {
		return {
			success: false,
			message: `Barcode format ${response.format} is not valid for a ${requiredKind} scan.`
		};
	}

	const resolved = await resolveBarcode(value, response.format);
	if (!resolved) {
		return { success: false, message: 'Barcode could not be identified.' };
	}

	if (resolved.kind !== requiredKind) {
		return {
			success: false,
			message: `Expected a ${requiredKind} barcode, but the scan resolved as ${resolved.kind}.`
		};
	}

	if (typeof keyword === 'string' && keyword.trim().length > 0) {
		const needle = keyword.trim().toLowerCase();
		const titleWords = resolved.title
			.toLowerCase()
			.split(/[\s\-_,.;:!?()/\\]+/)
			.filter(Boolean);
		if (!titleWords.includes(needle)) {
			return {
				success: false,
				message: `Resolved title "${resolved.title}" does not contain the required keyword "${keyword}".`
			};
		}
	}

	return {
		success: true,
		kind: resolved.kind,
		title: resolved.title,
		metadata: resolved.metadata
	};
}

function validateMobileDevice(
	data: QuestDeviceMetadata
): { success: true } | { success: false; message: string } {
	const make = (data.make ?? '').toLowerCase().trim();
	const model = (data.model ?? '').toLowerCase().trim();
	const os = (data.os ?? '').toLowerCase().trim();

	// API/admin submissions are exempt.
	if (os === 'web' && model === 'api') {
		return { success: true };
	}

	if (os === 'windows' || os === 'macos' || os === 'linux') {
		return {
			success: false,
			message: `This step requires a mobile device. Declared OS "${data.os}" is a desktop platform.`
		};
	}

	if (model === 'mac' || model === 'pc' || model === 'desktop') {
		return {
			success: false,
			message: `This step requires a mobile device. Declared model "${data.model}" is a desktop device.`
		};
	}

	// Make alone is ambiguous (Apple/Samsung/etc. make both mobile and desktop); unknown makes pass.
	void make;
	return { success: true };
}

// main validation function

export async function validateStep(
	step: QuestStep,
	response: QuestStepResponse,
	bindings: Bindings,
	data: QuestDeviceMetadata,
	context?: QuestValidationContext
): Promise<{
	success: boolean;
	message?: string;
	score?: number;
	prompt?: string;
	kind?: BarcodeResolution['kind'];
	title?: string;
	metadata?: Record<string, unknown>;
}> {
	if (step.type !== response.type) {
		return { success: false, message: `Expected response type ${step.type}, got ${response.type}` };
	}

	if (step.mobile_only === true) {
		const mobileCheck = validateMobileDevice(data);
		if (!mobileCheck.success) {
			return mobileCheck;
		}
	}

	switch (response.type) {
		case 'take_photo_location':
		case 'take_photo_classification':
		case 'take_photo_caption':
		case 'take_photo_objects':
		case 'take_photo_validation':
		case 'take_photo_list': {
			if (!response.data) {
				return { success: false, message: 'No photo data provided in response.' };
			}

			return await validateStepPhoto(step, response.data, bindings, data);
		}
		case 'draw_picture': {
			if (!response.data) {
				return { success: false, message: 'No drawing data provided in response.' };
			}

			return await validateDrawing(step, response.data, bindings);
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
		case 'article_read_time':
		case 'activity_read_time': {
			return validateReadTimeStep(step, response);
		}
		case 'nature_minutes': {
			return validateNatureMinutesStep(step, response, bindings, context);
		}
		case 'trailmarker_added': {
			return validateTrailmarkerAddedStep(step, response, bindings, context);
		}
		case 'describe_text': {
			return await validateDescribeText(step, response, bindings);
		}
		case 'scan_barcode': {
			return await validateScanBarcode(step, response);
		}
		// types validated outside the worker (mantle2)
		case 'attend_event':
		case 'match_terms':
		case 'order_items':
		case 'respond_to_prompt':
		case 'submit_event_image':
		case 'distance_covered':
			return { success: true };
		default: {
			const exhaustive: never = response;
			return {
				success: false,
				message: `Unknown quest step type: ${(exhaustive as { type?: string }).type ?? 'undefined'}`
			};
		}
	}
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
	const normalizedThreshold = normalizeThreshold(threshold, 'Article quiz');
	if (!normalizedThreshold.ok) {
		return {
			success: false,
			message: normalizedThreshold.message
		};
	}

	const requiredPercent = normalizedThreshold.value * 100;

	if (quizData.scorePercent < requiredPercent) {
		return {
			success: false,
			message: `Quiz score ${quizData.scorePercent.toFixed(1)}% does not meet the required ${requiredPercent}%.`
		};
	}

	return { success: true };
}

function validateReadTimeStep(
	step: QuestStep,
	response: QuestStepResponse & { type: 'article_read_time' | 'activity_read_time' }
) {
	if (step.type !== response.type) {
		return {
			success: false,
			message: `Expected ${step.type} step, got ${response.type}`
		};
	}

	const [, requiredSeconds] = step.parameters;
	if (
		typeof requiredSeconds !== 'number' ||
		!Number.isFinite(requiredSeconds) ||
		requiredSeconds < 0
	) {
		return {
			success: false,
			message: `${step.type} requires a valid minimum read time threshold.`
		};
	}

	if (typeof response.duration !== 'number' || !Number.isFinite(response.duration)) {
		return {
			success: false,
			message: 'No read time duration was provided.'
		};
	}

	if (response.duration < requiredSeconds) {
		return {
			success: false,
			message: `Read time ${response.duration.toFixed(1)}s does not meet the required ${requiredSeconds}s.`
		};
	}

	return { success: true, score: response.duration };
}

async function validateNatureMinutesStep(
	step: QuestStep,
	response: QuestStepResponse & { type: 'nature_minutes' },
	bindings: Bindings,
	context?: QuestValidationContext
): Promise<{ success: boolean; message?: string; score?: number }> {
	if (step.type !== 'nature_minutes') {
		return { success: false, message: `Expected nature_minutes step, got ${step.type}` };
	}

	if (response.type !== 'nature_minutes') {
		return { success: false, message: `Expected nature_minutes response, got ${response.type}` };
	}

	const [requiredMinutes] = step.parameters;
	if (
		typeof requiredMinutes !== 'number' ||
		!Number.isFinite(requiredMinutes) ||
		requiredMinutes < 0
	) {
		return {
			success: false,
			message: 'nature_minutes requires a valid minimum minutes threshold.'
		};
	}

	// timing context is required so only minutes accrued since the step unlocked are counted
	if (!context || !context.userId || typeof context.stepAchievableAt !== 'number') {
		return {
			success: false,
			message: 'Nature minutes could not be validated without quest timing context.'
		};
	}

	const accumulated = await getNatureMinutesSince(
		bindings,
		context.userId,
		context.stepAchievableAt
	);
	if (accumulated < requiredMinutes) {
		return {
			success: false,
			message: `Accumulated nature minutes (${accumulated}) do not meet the required ${requiredMinutes}.`
		};
	}

	return { success: true, score: accumulated };
}

async function validateTrailmarkerAddedStep(
	step: QuestStep,
	response: QuestStepResponse & { type: 'trailmarker_added' },
	bindings: Bindings,
	context?: QuestValidationContext
): Promise<{ success: boolean; message?: string }> {
	if (step.type !== 'trailmarker_added') {
		return { success: false, message: `Expected trailmarker_added step, got ${step.type}` };
	}

	if (response.type !== 'trailmarker_added') {
		return { success: false, message: `Expected trailmarker_added response, got ${response.type}` };
	}

	const [keyword, authorId] = step.parameters;
	const needle =
		typeof keyword === 'string' && keyword.trim().length > 0 ? keyword.trim().toLowerCase() : null;
	const requiredAuthor =
		typeof authorId === 'number' && Number.isFinite(authorId)
			? normalizeId(String(authorId))
			: null;

	if (!context || !context.userId || typeof context.stepAchievableAt !== 'number') {
		return {
			success: false,
			message: 'Trailmark step could not be validated without quest timing context.'
		};
	}

	const since = context.stepAchievableAt;
	const marks = await getUserTrailmarks(bindings, context.userId);
	const match = marks.find((m) => {
		if (!m || typeof m.note !== 'string') return false;
		const at = Date.parse(m.created_at);
		if (!Number.isFinite(at) || at < since) return false;
		if (needle && !m.note.toLowerCase().includes(needle)) return false;
		if (requiredAuthor && normalizeId(m.author_uid) !== requiredAuthor) return false;
		return true;
	});

	if (!match) {
		return {
			success: false,
			message: needle
				? `No trailmark containing "${keyword}" was added since this step unlocked.`
				: 'No qualifying trailmark was added since this step unlocked.'
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

		const osRaw = data.os?.toLowerCase()?.trim() ?? '';
		const os = osRaw === 'ipados' ? 'ios' : osRaw;
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
	const normalizedThreshold = normalizeThreshold(threshold, 'Audio score');
	if (!normalizedThreshold.ok) {
		return {
			success: false,
			message: normalizedThreshold.message
		};
	}

	let score: ScoreResult;
	try {
		const [, scored] = await withAITimeout('scoreAudio', () =>
			scoreAudio(bindings, audio, prompt, [
				{
					id: 'relevance',
					weight: 0.7,
					ideal: `The audio clearly discusses and is relevant to: ${prompt}`
				},
				{
					id: 'clarity',
					weight: 0.3,
					ideal: 'The audio is clear, intelligible, and demonstrates understanding of the topic'
				}
			])
		);
		score = scored;
	} catch (err) {
		if (err instanceof AIValidationTimeoutError) {
			return {
				success: false,
				message: 'Audio validation timed out — please retry.'
			};
		}
		return aiUnavailableResult();
	}

	if (score.score < normalizedThreshold.value) {
		return {
			success: false,
			message: `Audio does not meet the required score threshold of ${normalizedThreshold.value}. Got ${score.score}.`
		};
	}

	return { success: true, score: score.score };
}

async function validateStepPhoto(
	step: QuestStep,
	image: Uint8Array,
	bindings: Bindings,
	data: QuestDeviceMetadata
): Promise<{ success: boolean; message?: string; score?: number; prompt?: string }> {
	let metadata: ExifReader.Tags | null = null;
	try {
		metadata = ExifReader.load(image.buffer as ArrayBuffer);
	} catch {
		// Keep strict location checks, but allow non-location photo flows to proceed.
		if (step.type === 'take_photo_location') {
			return { success: false, message: 'Failed to parse photo EXIF metadata for location check.' };
		}
	}

	const hasExif = metadata != null;

	// Make is required: its absence indicates the image was not taken by a real camera app
	const makeRaw = metadata?.Make?.value?.toString()?.trim();
	const make = makeRaw?.toLowerCase() ?? '';

	// DateTimeOriginal is required: absence or unparseable value rejects the submission
	const dateRaw = metadata?.DateTimeOriginal?.value?.toString()?.trim();

	// If EXIF exists but DateTimeOriginal is missing, reject
	if (hasExif && !dateRaw) {
		return { success: false, message: 'Photo is missing EXIF DateTimeOriginal value.' };
	}

	// EXIF DateTimeOriginal is a naive local time (YYYY:MM:DD HH:MM:SS format)
	let dateTaken: number | null = null;
	if (dateRaw) {
		const dateMatch = dateRaw.match(/(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
		if (!dateMatch) {
			return { success: false, message: 'Photo has an unparseable EXIF DateTimeOriginal value.' };
		}

		const [, year, month, day, hour, minute, second] = dateMatch;
		const utcDate = new Date(
			Date.UTC(
				parseInt(year),
				parseInt(month) - 1,
				parseInt(day),
				parseInt(hour),
				parseInt(minute),
				parseInt(second)
			)
		);
		dateTaken = utcDate.getTime();

		if (!Number.isFinite(dateTaken)) {
			return { success: false, message: 'Photo has an unparseable EXIF DateTimeOriginal value.' };
		}
	}

	// OffsetTimeOriginal (e.g., "-05:00" for UTC-5) tells us the timezone offset of the naive local time.
	// to convert from naive local time (parsed as UTC above) to true UTC:
	// true_utc = parsed_as_utc - offsetMs
	const offsetRaw = metadata?.OffsetTimeOriginal?.value?.toString()?.trim() ?? null;
	if (offsetRaw && dateTaken != null) {
		const parts = offsetRaw.split(':').map(Number);
		if (parts.length >= 2 && parts.every(Number.isFinite)) {
			// parts[0] is hours (can be negative), parts[1] is minutes (always positive magnitude)
			// For "-05:30", parts = [-5, 30], offsetMinutes = -5*60 - 30 = -330
			// For "+05:30", parts = [5, 30], offsetMinutes = 5*60 + 30 = 330
			const offsetMinutes =
				parts[0] * 60 + (parts[0] < 0 ? -Math.abs(parts[1]) : Math.abs(parts[1]));
			const offsetMs = offsetMinutes * 60 * 1000;
			// Convert naive local time (parsed as UTC) to actual UTC
			dateTaken -= offsetMs;
		}
	}

	// allow 30-minute skew to account for client upload latency and imperfect clocks
	const now = Date.now();
	if (dateTaken != null && Math.abs(now - dateTaken) > 30 * 60 * 1000) {
		return {
			success: false,
			message: `Photo timestamp is not within the acceptable range (possible clock skew or old photo). Found ${new Date(dateTaken).toISOString()}, but expected around ${new Date(now).toISOString()}.`
		};
	}

	const softwareRaw = metadata?.Software?.value?.toString()?.trim() ?? '';
	const nonCameraReason = detectNonCameraSoftware(softwareRaw);
	if (nonCameraReason) {
		return {
			success: false,
			message: `${nonCameraReason}: "${softwareRaw}".`
		};
	}

	// focal length of 0 is physically impossible in real cameras
	const focalLength = metadata?.FocalLength?.value;
	if (focalLength != null && Number(focalLength) === 0) {
		return {
			success: false,
			message: 'Photo has invalid focal length (0), indicating a virtual or manipulated image.'
		};
	}

	// DateTime Digitized should match Original; large gaps indicate editing/conversion
	const dateDigitized = metadata?.DateTimeDigitized?.value?.toString()?.trim();
	if (dateDigitized && dateRaw && dateTaken != null && dateDigitized !== dateRaw) {
		// Parse the digitized date
		const digitizedTime = new Date(
			dateDigitized.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3')
		).getTime();

		if (Number.isFinite(digitizedTime)) {
			// Allow 5 minutes of difference (metadata write-order differences), but flag larger gaps
			const timeDiff = Math.abs(dateTaken - digitizedTime);
			if (timeDiff > 5 * 60 * 1000) {
				return {
					success: false,
					message: `DateTime Original and DateTime Digitized mismatch (${(timeDiff / 1000).toFixed(0)}s apart), indicating post-processing.`
				};
			}
		}
	}

	const hasAperture = metadata?.ApertureValue != null || metadata?.FNumber != null;
	const hasLens = metadata?.LensModel != null;
	const hasExposure = metadata?.ExposureTime != null;
	const hasFocal = metadata?.FocalLength != null;
	const evidenceCount = [hasLens, hasAperture, hasExposure, hasFocal].filter(Boolean).length;
	const isSuspiciouslyBare = hasExif && evidenceCount === 0;

	if (isSuspiciouslyBare) {
		return {
			success: false,
			message:
				'Photo is missing critical camera EXIF fields (aperture, lens, exposure, focal length), indicating a synthetic or heavily manipulated image.'
		};
	}

	// make cross-check: accept if either string contains the other to handle verbose OEM strings
	// e.g. "SAMSUNG ELECTRONICS" still matches declared "samsung"
	if (makeRaw && data.make && data.make !== 'unknown') {
		const expectedMake = data.make.toLowerCase().trim();
		if (!make.includes(expectedMake) && !expectedMake.includes(make)) {
			return {
				success: false,
				message: `Expected device make "${data.make}", but EXIF reports "${makeRaw}".`
			};
		}
	}

	// model cross-check: normalise aggressively since OEM model strings vary wildly in punctuation
	const modelRaw = metadata?.Model?.value?.toString()?.trim();
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

	// OS cross-validation. UA-CH on iPad sometimes reports `ipados`; treat it as `ios`
	// since they share the same Apple-hardware constraint.
	const os = (() => {
		const raw = data.os?.toLowerCase()?.trim() ?? '';
		return raw === 'ipados' ? 'ios' : raw;
	})();
	if (os && os !== 'unknown' && makeRaw) {
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

	let aiScore = 0;

	// type-based validation
	if (step.type === 'take_photo_location' || step.type === 'take_photo_classification') {
		let label: string | undefined;
		let score: number | undefined;
		if (step.type === 'take_photo_location') {
			// validate both device GPS data and photo EXIF GPS data
			if (!metadata) {
				return {
					success: false,
					message: 'Location validation requires readable EXIF metadata.'
				};
			}

			const [lat, lng, radius, label0, score0] = step.parameters;
			if ((label0 && score0 === undefined) || (!label0 && score0 !== undefined)) {
				return {
					success: false,
					message: 'Location-based classification requires both a label and a confidence threshold.'
				};
			}

			if (score0 !== undefined) {
				const normalizedThreshold = normalizeThreshold(score0, 'Location classification');
				if (!normalizedThreshold.ok) {
					return {
						success: false,
						message: normalizedThreshold.message
					};
				}
				score = normalizedThreshold.value;
			}

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
		}

		if (step.type === 'take_photo_classification') {
			const [label0, score0] = step.parameters;
			const normalizedThreshold = normalizeThreshold(score0, 'Image classification');
			if (!normalizedThreshold.ok) {
				return {
					success: false,
					message: normalizedThreshold.message
				};
			}

			label = label0;
			score = normalizedThreshold.value;
		}

		if (label && score !== undefined) {
			const normalizedLabel = normalizeVisionLabel(label);

			const candidateLabels = expandVisionLabelCandidates(normalizedLabel);
			if (
				![...candidateLabels].some((candidate) =>
					IMAGENET_CLASSIFICATION_LABELS.has(candidate as any)
				)
			) {
				return {
					success: false,
					message: `Classification label "${normalizedLabel}" is not supported by the current classification model vocabulary.`
				};
			}

			let classifications: { label: string; confidence: number }[];
			try {
				classifications = await withAITimeout('classifyImage', () =>
					classifyImage(bindings, image)
				);
			} catch (err) {
				if (err instanceof AIValidationTimeoutError) {
					return {
						success: false,
						message: 'Photo validation timed out, please retry.'
					};
				}
				return aiUnavailableResult();
			}
			const classification = findBestLabelConfidence(classifications, normalizedLabel);

			if (!classification || classification.confidence < score) {
				const foundLabels = classifications
					.slice(0, 6)
					.map((c) => `${normalizeVisionLabel(c.label)} (${c.confidence.toFixed(2)})`)
					.join(', ');
				return {
					success: false,
					message: `Photo does not meet the required classification label "${normalizedLabel}" with confidence ${score}. Top labels: ${foundLabels || 'none'}.`
				};
			}

			aiScore = classification.confidence;
		}
	}

	if (step.type === 'take_photo_objects') {
		const labelsAndScores = step.parameters;
		if (!labelsAndScores.length) {
			return {
				success: false,
				message: 'Object detection step requires at least one object label and threshold.'
			};
		}

		let detections: { label: string; confidence: number; box: [number, number, number, number] }[];
		try {
			detections = await withAITimeout('detectObjects', () => detectObjects(bindings, image));
		} catch (err) {
			if (err instanceof AIValidationTimeoutError) {
				return {
					success: false,
					message: 'Photo validation timed out, please retry.'
				};
			}
			return aiUnavailableResult();
		}
		const requiredScores: number[] = [];

		for (const [labelRaw, scoreRaw] of labelsAndScores) {
			const label = normalizeVisionLabel(labelRaw);
			const candidateLabels = expandVisionLabelCandidates(label);
			if (![...candidateLabels].some((candidate) => COCO_OBJECT_LABELS.has(candidate as any))) {
				return {
					success: false,
					message: `Object label "${label}" is not supported by the current detection model vocabulary.`
				};
			}

			const normalizedThreshold = normalizeThreshold(scoreRaw, `Object "${label}"`);
			if (!normalizedThreshold.ok) {
				return {
					success: false,
					message: normalizedThreshold.message
				};
			}

			const bestDetection = findBestLabelConfidence(detections, label);

			if (!bestDetection || bestDetection.confidence < normalizedThreshold.value) {
				return {
					success: false,
					message: `Photo does not contain the required object "${label}" with confidence ${normalizedThreshold.value} (${bestDetection?.confidence.toFixed(2) || 'failed to detect'}).`
				};
			}

			requiredScores.push(bestDetection.confidence);
		}

		aiScore = requiredScores.reduce((acc, d) => acc + d, 0) / requiredScores.length;
	}

	if (step.type === 'take_photo_caption') {
		const [criteria, prompt, threshold] = step.parameters;
		const normalizedThreshold = normalizeThreshold(threshold, 'Caption score');
		if (!normalizedThreshold.ok) {
			return {
				success: false,
				message: normalizedThreshold.message
			};
		}

		const captionPrompt = `Describe this photo in detail: what is the main subject, what is the setting, and what context is visible? The photo is expected to show: ${prompt}.`;
		let caption: string;
		let score: ScoreResult;
		try {
			[caption, score] = await withAITimeout('scoreImage:caption', () =>
				scoreImage(bindings, image, captionPrompt, criteria)
			);
		} catch (err) {
			if (err instanceof AIValidationTimeoutError) {
				return {
					success: false,
					message: 'Photo validation timed out, please retry.'
				};
			}
			return aiUnavailableResult();
		}
		if (score.score < normalizedThreshold.value) {
			return {
				success: false,
				message: `Photo caption does not meet the required score threshold of ${normalizedThreshold.value}. Got ${score.score}.`
			};
		}
		return { success: true, score: score.score, prompt: caption };
	}

	if (step.type === 'take_photo_validation') {
		const [prompt, thresholdRaw] = step.parameters;
		const threshold = thresholdRaw ?? 0.5; // default to 0.5 if not specified
		const normalizedThreshold = normalizeThreshold(threshold, 'Photo validation');
		if (!normalizedThreshold.ok) {
			return {
				success: false,
				message: normalizedThreshold.message
			};
		}

		const captionPrompt = `Describe this photo in detail: what is the main subject, what is the setting, and what context is visible? The photo is expected to show: ${prompt}. Describe whether the photo clearly shows the expected subject with good quality and relevance.`;
		let caption: string;
		let score: ScoreResult;
		try {
			[caption, score] = await withAITimeout('scoreImage:validation', () =>
				scoreImage(bindings, image, captionPrompt, [
					{
						id: 'validation',
						weight: 1,
						ideal: `The photo clearly shows ${prompt} with good quality and relevance.`
					}
				])
			);
		} catch (err) {
			if (err instanceof AIValidationTimeoutError) {
				return {
					success: false,
					message: 'Photo validation timed out, please retry.'
				};
			}
			return aiUnavailableResult();
		}

		if (score.score < normalizedThreshold.value) {
			return {
				success: false,
				message: `Photo does not meet the required validation score threshold of ${normalizedThreshold.value}. Got ${score.score.toFixed(2)}.`
			};
		}

		return { success: true, score: score.score, prompt: caption };
	}

	if (step.type === 'take_photo_list') {
		const [items, thresholdRaw] = step.parameters;
		if (!items || items.length === 0) {
			return {
				success: false,
				message: 'Photo list validation step requires at least one item.'
			};
		}

		// Allow arbitrary item lists — scoring is performed via `scoreImage` (caption-scoring).
		// We keep a lightweight normalization pass for prompt generation but do not reject
		// items that are not part of the COCO vocabulary so domain-specific nouns are allowed.

		const threshold = thresholdRaw ?? 0.5; // default to 0.5 if not specified
		const normalizedThreshold = normalizeThreshold(threshold, 'Photo list validation');
		if (!normalizedThreshold.ok) {
			return {
				success: false,
				message: normalizedThreshold.message
			};
		}

		const itemsList = items.join(', ');
		const captionPrompt = `List the main objects, subjects, and context visible in this photo in detail. The photo is expected to show the following items: ${itemsList}. Describe whether these items are clearly visible.`;
		let caption: string;
		let score: ScoreResult;
		try {
			[caption, score] = await withAITimeout('scoreImage:list', () =>
				scoreImage(bindings, image, captionPrompt, [
					{
						id: 'list',
						weight: 1,
						ideal: `The photo clearly shows the following items: ${itemsList}.`
					}
				])
			);
		} catch (err) {
			if (err instanceof AIValidationTimeoutError) {
				return {
					success: false,
					message: 'Photo validation timed out, please retry.'
				};
			}
			return aiUnavailableResult();
		}

		if (score.score < normalizedThreshold.value) {
			return {
				success: false,
				message: `Photo does not meet the required list score threshold of ${normalizedThreshold.value}. Got ${score.score.toFixed(2)}.`
			};
		}

		return { success: true, score: score.score, prompt: caption };
	}

	return { success: true, score: aiScore };
}

async function validateDrawing(
	step: QuestStep,
	image: Uint8Array,
	bindings: Bindings
): Promise<{ success: boolean; message?: string; score?: number }> {
	if (step.type !== 'draw_picture') {
		return { success: false, message: `Expected draw_picture step, got ${step.type}` };
	}

	// Canvas-drawn images from canvas.toDataURL() should have no EXIF data at all.
	// Attempt to parse EXIF; if it exists and has camera metadata, it's a photo, not a drawing.
	let metadata: ExifReader.Tags | null = null;
	try {
		metadata = ExifReader.load(image.buffer as ArrayBuffer);
	} catch {
		// No EXIF data or corrupt — expected for canvas drawings. Continue validation.
	}

	// Reject if camera metadata is present
	if (metadata) {
		const hasExifData =
			metadata.Make != null ||
			metadata.Model != null ||
			metadata.DateTimeOriginal != null ||
			metadata.Software != null;
		if (hasExifData) {
			return {
				success: false,
				message:
					'Drawing submission contains camera EXIF metadata, indicating it was not created with a drawing tool. Please draw a new picture in the browser.'
			};
		}
	}

	const [prompt, threshold] = step.parameters;
	const normalizedThreshold = normalizeThreshold(threshold, 'Drawing score');
	if (!normalizedThreshold.ok) {
		return {
			success: false,
			message: normalizedThreshold.message
		};
	}

	// ask the model to describe what is drawn so we can score accuracy against the prompt
	const captionPrompt = 'Describe the main object or subject that is drawn in this image.';
	let score: ScoreResult;
	try {
		const [, scored] = await withAITimeout('scoreImage:drawing', () =>
			scoreImage(bindings, image, captionPrompt, [
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
			])
		);
		score = scored;
	} catch (err) {
		if (err instanceof AIValidationTimeoutError) {
			return {
				success: false,
				message: 'Drawing validation timed out — please retry.'
			};
		}
		return aiUnavailableResult();
	}
	if (score.score < normalizedThreshold.value) {
		return {
			success: false,
			message: `Drawing does not meet the required score threshold of ${normalizedThreshold.value}. Got ${score.score.toFixed(2)}.`
		};
	}

	return { success: true, score: score.score };
}

async function validateDescribeText(
	step: QuestStep,
	response: QuestStepResponse & { type: 'describe_text' },
	bindings: Bindings
): Promise<{ success: boolean; message?: string; score?: number; prompt?: string }> {
	if (step.type !== 'describe_text') {
		return { success: false, message: `Expected describe_text step, got ${step.type}` };
	}

	if (typeof response.text !== 'string') {
		return { success: false, message: 'Text response must be a string.' };
	}

	const normalizedText = response.text.trim();
	if (!normalizedText) {
		return { success: false, message: 'Text response cannot be empty.' };
	}

	const [criteria, threshold, rawMinLength, rawMaxLength] = step.parameters;

	// the absolute window — per-step values get clamped into [50, 2048] so a
	// misconfigured step can't drop below the floor or exceed the hard ceiling.
	const TEXT_FLOOR = 50;
	const TEXT_CEILING = 2048;
	const clampLen = (n: number, fallback: number) =>
		Math.min(TEXT_CEILING, Math.max(TEXT_FLOOR, Math.floor(n)));

	const minLength =
		typeof rawMinLength === 'number' && Number.isFinite(rawMinLength)
			? clampLen(rawMinLength, 200)
			: 200;
	const maxLength =
		typeof rawMaxLength === 'number' && Number.isFinite(rawMaxLength)
			? clampLen(rawMaxLength, TEXT_CEILING)
			: TEXT_CEILING;

	const effectiveMax = Math.max(minLength, maxLength);

	if (normalizedText.length < minLength) {
		return {
			success: false,
			message: `Response text is less than ${minLength} characters.`
		};
	}

	if (normalizedText.length > effectiveMax) {
		return {
			success: false,
			message: `Response text exceeds maximum length of ${effectiveMax} characters.`
		};
	}

	const normalizedThreshold = normalizeThreshold(threshold, 'Text description score');
	if (!normalizedThreshold.ok) {
		return {
			success: false,
			message: normalizedThreshold.message
		};
	}

	let score: ScoreResult;
	try {
		score = await withAITimeout('scoreText', () => scoreText(bindings, normalizedText, criteria));
	} catch (err) {
		if (err instanceof AIValidationTimeoutError) {
			return {
				success: false,
				message: 'Text validation timed out — please retry.'
			};
		}
		return aiUnavailableResult();
	}
	if (score.score < normalizedThreshold.value) {
		return {
			success: false,
			message: `Text description does not meet the required score threshold of ${normalizedThreshold.value}. Got ${score.score.toFixed(2)}.`
		};
	}

	return { success: true, score: score.score, prompt: normalizedText };
}
