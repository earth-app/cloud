export function base64ToUint8Array(base64: string): Uint8Array {
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
}

// Helper to encode Uint8Array to base64 (if needed)
export function uint8ArrayToBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

export function detectImageMime(bytes: Uint8Array): string {
    // PNG: [0x89, 0x50, 0x4E, 0x47]
    if (bytes.length >= 4 &&
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4E &&
        bytes[3] === 0x47) {
        return 'image/png';
    }

    // JPEG: [0xFF, 0xD8]
    if (bytes.length >= 2 &&
        bytes[0] === 0xFF &&
        bytes[1] === 0xD8) {
        return 'image/jpeg';
    }

    return 'application/octet-stream';
}