import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, degrees } from 'pdf-lib';
import { unzipSync } from 'fflate';
import { fittedSize, inspectImageHeader, processImage } from '../src/processors/image.js';
import { parsePages, parseGroups, checkRenderSizes, processPdf } from '../src/processors/pdf.js';

async function fixture(widths, rotation = 0) {
  const document = await PDFDocument.create();
  for (const width of widths) document.addPage([width, 200]).setRotation(degrees(rotation));
  return new File([await document.save()], '原件.pdf', { type: 'application/pdf' });
}
async function read(blob) { return PDFDocument.load(await blob.arrayBuffer()); }
const widths = document => document.getPages().map(page => page.getWidth());

test('page expressions preserve reverse ranges, input order and explicit repeats', () => {
  assert.deepEqual(parsePages('3-1,2，5', 5), [2, 1, 0, 1, 4]);
  assert.deepEqual(parsePages(' 1 – 3 ', 3), [0, 1, 2]);
  assert.deepEqual(parsePages('', 2), [0, 1]);
  assert.deepEqual(parseGroups('3-2;1，1', 3), [[2, 1], [0, 0]]);
  assert.deepEqual(parseGroups('', 2), [[0], [1]]);
});

test('malformed, out-of-range and excessive output selections fail before writing', () => {
  for (const expression of ['0', '-1', '4', '1,,2', '1,', '1.2', '1e1', '1-2-3', '1;2', '1/-2', '9007199254740992']) {
    assert.throws(() => parsePages(expression, 3));
  }
  assert.throws(() => parsePages({}, 3), /页码表达式/);
  assert.throws(() => parsePages('', 21, 20), /20 页/);
  assert.throws(() => parseGroups('1;', 3), /不允许留空/);
  assert.throws(() => parseGroups('1-200;1', 200), /200 页/);
  assert.throws(() => parsePages('1,'.repeat(200) + '1', 1), /200 页/);
});

test('merge retains actual page order and rotations and leaves input bytes untouched', async () => {
  const first = await fixture([110, 120], 90), second = await fixture([210]);
  const original = Buffer.from(await first.arrayBuffer());
  const result = await processPdf([first, second], { mode: 'merge' });
  const document = await read(result.outputs[0].blob);
  assert.deepEqual(widths(document), [110, 120, 210]);
  assert.deepEqual(document.getPages().map(page => page.getRotation().angle), [90, 90, 0]);
  assert.deepEqual(Buffer.from(await first.arrayBuffer()), original);
  assert.match(result.warnings.join(''), /数字签名/);
});

test('split produces a real ZIP with complete PDFs in specified groups', async () => {
  const result = await processPdf([await fixture([110, 120, 130])], { mode: 'split', groups: '3-2;1,1' });
  const entries = unzipSync(new Uint8Array(await result.outputs[0].blob.arrayBuffer()));
  assert.equal(result.outputs[0].blob.type, 'application/zip');
  assert.equal(Object.keys(entries).length, 2);
  assert.deepEqual(widths(await PDFDocument.load(entries['001_拆分.pdf'])), [130, 120]);
  assert.deepEqual(widths(await PDFDocument.load(entries['002_拆分.pdf'])), [110, 110]);
  const every = await processPdf([await fixture([110, 120])], { mode: 'split' });
  assert.equal(Object.keys(unzipSync(new Uint8Array(await every.outputs[0].blob.arrayBuffer()))).length, 2);
});

test('extract retains repeated pages; rotate changes selected original pages once', async () => {
  const file = await fixture([110, 120, 130], 90);
  const extracted = await processPdf([file], { mode: 'extract', pages: '3-1,3' });
  assert.deepEqual(widths(await read(extracted.outputs[0].blob)), [130, 120, 110, 130]);
  const rotated = await processPdf([file], { mode: 'rotate', pages: '3,1,3', angle: 270 });
  assert.deepEqual((await read(rotated.outputs[0].blob)).getPages().map(page => page.getRotation().angle), [0, 90, 0]);
  assert.deepEqual((await read(file)).getPages().map(page => page.getRotation().angle), [90, 90, 90]);
  await assert.rejects(processPdf([file], { mode: 'rotate', angle: 91 }), /旋转角度/);
});

test('PDF rejects corrupt, encrypted, unsupported and resource-heavy requests', async () => {
  await assert.rejects(processPdf([new File(['not a PDF'], 'pretend.pdf')]), /不是有效/);
  await assert.rejects(processPdf([new File(['%PDF-1.7\ntruncated'], 'broken.pdf')]), /无法读取/);
  await assert.rejects(processPdf([await fixture([100])], { mode: 'compress' }), /压缩/);
  await assert.rejects(processPdf([{ size: 51 * 1024 * 1024, arrayBuffer() { throw new Error('must not read'); } }]), /50 MB/);
  await assert.rejects(processPdf([await fixture(Array(101).fill(100)), await fixture(Array(100).fill(100))]), /总页数/);
  const encrypted = await PDFDocument.create();
  encrypted.addPage();
  encrypted.context.trailerInfo.Encrypt = encrypted.context.register(encrypted.context.obj({ Filter: PDFName.of('Standard'), V: 1, R: 2 }));
  await assert.rejects(processPdf([new File([await encrypted.save()], 'encrypted.pdf')]), /加密/);
});

test('PDF render limits account for rounded dimensions and aggregate pixel allocations', () => {
  assert.doesNotThrow(() => checkRenderSizes([{ width: 1000, height: 2000 }]));
  assert.throws(() => checkRenderSizes([{ width: 5000.1, height: 5000 }]), /单页/);
  assert.throws(() => checkRenderSizes(Array(5).fill({ width: 5000, height: 5000 })), /本批/);
  for (const width of [NaN, Infinity, 0, -1, 32768]) assert.throws(() => checkRenderSizes([{ width, height: 1 }]));
});

test('image header preflight rejects pixel bombs, animations and high bit depth', () => {
  const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVQImWMAAQAABQABDQottAAAAABJRU5ErkJggg==', 'base64'));
  assert.deepEqual(inspectImageHeader(png), { width: 1, height: 1, mime: 'image/png' });
  const bomb = png.slice(); new DataView(bomb.buffer).setUint32(16, 30000); new DataView(bomb.buffer).setUint32(20, 30000);
  assert.throws(() => inspectImageHeader(bomb), /2500 万像素/);
  const deep = png.slice(); deep[24] = 16;
  assert.throws(() => inspectImageHeader(deep), /8 位/);
  const animation = png.slice(); animation.set(new TextEncoder().encode('acTL'), 37);
  assert.throws(() => inspectImageHeader(animation), /动态 PNG/);
  assert.throws(() => inspectImageHeader(new TextEncoder().encode('<svg width="100"/>')), /SVG/);
  assert.throws(() => inspectImageHeader(png.subarray(0, 31)), /文件头/);
});

test('image dimensions use a bounding box without stretching', () => {
  assert.deepEqual(fittedSize(800, 400, 200, 200), { width: 200, height: 100 });
  assert.deepEqual(fittedSize(800, 400, 0, 50), { width: 100, height: 50 });
  assert.deepEqual(fittedSize(100, 400, 0, 0), { width: 100, height: 400 });
  assert.throws(() => fittedSize(1, 1, 6001, 0), /宽度/);
  assert.throws(() => fittedSize(5000, 5000, 6000, 6000), /2500 万像素/);
});

test('image options reject before browser allocation on invalid requests', async () => {
  await assert.rejects(processImage([], {}), /1–20/);
  await assert.rejects(processImage([{}], { format: 'gif' }), /请选择/);
  await assert.rejects(processImage([{}], { quality: 1 }), /质量/);
  await assert.rejects(processImage([{}], { format: 'pdf', targetKB: 1 }), /不支持指定/);
});
