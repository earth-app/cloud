import ExifReader from 'exifreader';
import { describe, expect, it } from 'vitest';

function jpegWithGps(): ArrayBuffer {
	const tiff = new DataView(new ArrayBuffer(128));
	tiff.setUint16(0, 0x4949);
	tiff.setUint16(2, 42, true);
	tiff.setUint32(4, 8, true);

	tiff.setUint16(8, 1, true);
	tiff.setUint16(10, 0x8825, true);
	tiff.setUint16(12, 4, true);
	tiff.setUint32(14, 1, true);
	tiff.setUint32(18, 26, true);

	tiff.setUint16(26, 4, true);
	const entry = (at: number, tag: number, type: number, count: number, value: number) => {
		tiff.setUint16(at, tag, true);
		tiff.setUint16(at + 2, type, true);
		tiff.setUint32(at + 4, count, true);
		tiff.setUint32(at + 8, value, true);
	};
	entry(28, 1, 2, 2, 0x4e);
	entry(40, 2, 5, 3, 80);
	entry(52, 3, 2, 2, 0x57);
	entry(64, 4, 5, 3, 104);

	const rationals = (at: number, values: number[]) =>
		values.forEach((v, i) => {
			tiff.setUint32(at + i * 8, v, true);
			tiff.setUint32(at + i * 8 + 4, 1, true);
		});
	rationals(80, [40, 26, 0]);
	rationals(104, [74, 0, 0]);

	const bytes = new Uint8Array(4 + 2 + 6 + tiff.byteLength + 2);
	bytes.set([0xff, 0xd8, 0xff, 0xe1]);
	new DataView(bytes.buffer).setUint16(4, 2 + 6 + tiff.byteLength);
	bytes.set([0x45, 0x78, 0x69, 0x66, 0, 0], 6);
	bytes.set(new Uint8Array(tiff.buffer), 12);
	bytes.set([0xff, 0xd9], 12 + tiff.byteLength);
	return bytes.buffer;
}

describe('exifreader gps contract used by submitEventImage', () => {
	it('exposes signed decimal coordinates only in expanded mode', () => {
		const expanded = ExifReader.load(jpegWithGps(), { expanded: true });
		expect(expanded.gps?.Latitude).toBeCloseTo(40.4333, 3);
		expect(expanded.gps?.Longitude).toBeCloseTo(-74, 3);
	});

	it('has no gps group in flat mode, where the raw tags are rational tuples', () => {
		const flat = ExifReader.load(jpegWithGps()) as Record<string, any>;
		expect(flat.gps).toBeUndefined();
		expect(Number(flat.GPSLatitude?.value?.toString())).toBeNaN();
	});
});
