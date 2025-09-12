export function trimToByteLimit(str: string, byteLimit: number): string {
	const encoder = new TextEncoder();
	const chars = Array.from(str);
	const byteLens: number[] = chars.map((c) => encoder.encode(c).length);
	const cum: number[] = [];
	for (let i = 0; i < byteLens.length; i++) {
		cum[i] = byteLens[i] + (i > 0 ? cum[i - 1] : 0);
	}

	// Binary-search for highest index whose cum[idx] <= byteLimit
	let lo = 0;
	let hi = chars.length - 1;
	let cut = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >>> 1;
		if (cum[mid] <= byteLimit) {
			cut = mid;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}

	// If nothing fits, return empty; else join up to cut
	return cut >= 0 ? chars.slice(0, cut + 1).join('') : '';
}

export function toDataURL(image: Uint8Array | ArrayBuffer, type = 'image/png'): string {
	const bytes = image instanceof Uint8Array ? image : new Uint8Array(image);

	const chunkSize = 0x2000; // 8KB chunks to stay well under call stack/arg limits
	let binary = '';
	for (let i = 0; i < bytes.length; i += chunkSize) {
		const chunk = bytes.subarray(i, i + chunkSize);
		binary += String.fromCharCode.apply(null, Array.from(chunk));
	}

	return `data:${type};base64,` + btoa(binary);
}
