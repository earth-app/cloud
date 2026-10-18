import { parseBuffer } from 'music-metadata';
import { describe, expect, it } from 'vitest';

function cafBuffer(): Uint8Array {
	const header = new DataView(new ArrayBuffer(8));
	header.setUint32(0, 0x63616666);
	header.setUint16(4, 1);

	const desc = new DataView(new ArrayBuffer(12 + 32));
	desc.setUint32(0, 0x64657363);
	desc.setBigInt64(4, 32n);
	desc.setFloat64(12, 44100);
	desc.setUint32(20, 0x6c70636d);
	desc.setUint32(24, 0);
	desc.setUint32(28, 4);
	desc.setUint32(32, 1);
	desc.setUint32(36, 2);
	desc.setUint32(40, 16);

	const data = new DataView(new ArrayBuffer(12 + 4 + 44100 * 4));
	data.setUint32(0, 0x64617461);
	data.setBigInt64(4, BigInt(4 + 44100 * 4));

	const out = new Uint8Array(header.byteLength + desc.byteLength + data.byteLength);
	out.set(new Uint8Array(header.buffer), 0);
	out.set(new Uint8Array(desc.buffer), header.byteLength);
	out.set(new Uint8Array(data.buffer), header.byteLength + desc.byteLength);
	return out;
}

describe('music-metadata contract used by validateStepAudio', () => {
	it('reports a CAF container', async () => {
		const meta = await parseBuffer(cafBuffer());
		expect((meta.format.container ?? '').toLowerCase()).toBe('caf');
	});

	it('rejects bytes that are not audio instead of returning empty metadata', async () => {
		await expect(parseBuffer(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).rejects.toThrow();
	});
});
