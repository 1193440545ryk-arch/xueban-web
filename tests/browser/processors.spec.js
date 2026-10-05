import { test, expect } from '@playwright/test';
import { readdirSync } from 'node:fs';
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import { unzipSync } from 'fflate';

const requests = new WeakMap();
function workerPath() {
  const assets = readdirSync(new URL('../../dist-web/assets/', import.meta.url));
  const name = assets.find(name => /^processor\.worker-[\w-]+\.js$/.test(name));
  if (!name) throw new Error('先构建网站，再运行真实处理 Worker 测试。');
  return `/assets/${name}`;
}
const file = (bytes, name = '测试.pdf', type = 'application/pdf') => ({ bytes: Array.from(bytes), name, type });

async function process(page, kind, files, options = {}) {
  return page.evaluate(async ({ url, kind, files, options }) => {
    const worker = new Worker(url, { type: 'module' });
    try {
      return await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('处理 Worker 超时')), 65000);
        const done = callback => value => { clearTimeout(timeout); callback(value); };
        worker.onerror = done(event => reject(new Error(event.message)));
        worker.onmessage = async ({ data }) => {
          if (data.type === 'error') done(resolve)({ error: data.message });
          if (data.type === 'result') {
            const result = data.result;
            result.outputs = await Promise.all(result.outputs.map(async output => ({
              name: output.name, type: output.blob.type, bytes: Array.from(new Uint8Array(await output.blob.arrayBuffer())),
            })));
            done(resolve)(result);
          }
        };
        worker.postMessage({ kind, files: files.map(entry => new File([new Uint8Array(entry.bytes)], entry.name, { type: entry.type })), options: { ...options, assetBase: new URL('pdfjs/', location.href).href } });
      });
    } finally { worker.terminate(); }
  }, { url: workerPath(), kind, files, options });
}

async function bitmapFixture(page, { width = 80, height = 40, type = 'image/png', noise = false } = {}) {
  return page.evaluate(async ({ width, height, type, noise }) => {
    const canvas = new OffscreenCanvas(width, height), ctx = canvas.getContext('2d');
    if (noise) {
      const pixels = ctx.createImageData(width, height);
      let state = 42;
      for (let index = 0; index < pixels.data.length; index += 4) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        pixels.data[index] = state & 255; pixels.data[index + 1] = (state >>> 8) & 255; pixels.data[index + 2] = (state >>> 16) & 255; pixels.data[index + 3] = 255;
      }
      ctx.putImageData(pixels, 0, 0);
    } else { ctx.fillStyle = '#ff0000'; ctx.fillRect(width / 2, 0, width / 2, height); }
    const blob = await canvas.convertToBlob({ type, quality: 0.95 });
    return { bytes: Array.from(new Uint8Array(await blob.arrayBuffer())), name: `含透明的原图.${type === 'image/jpeg' ? 'jpg' : 'png'}`, type };
  }, { width, height, type, noise });
}

async function pixels(page, entry) {
  return page.evaluate(async ({ bytes, type }) => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    const pixel = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data);
    const result = { width: bitmap.width, height: bitmap.height, left: pixel(2, 2), right: pixel(bitmap.width - 3, 2) };
    bitmap.close(); return result;
  }, entry);
}

async function pdfFixture(widths = [240, 260], { text = true, rotation = 0 } = {}) {
  const document = await PDFDocument.create(), font = await document.embedFont(StandardFonts.Helvetica);
  widths.forEach((width, index) => {
    const page = document.addPage([width, 180]);
    page.setRotation(degrees(rotation));
    page.drawRectangle({ x: 0, y: 0, width: 20, height: 20, color: rgb(1, 0, 0) });
    if (text) page.drawText(`Page ${index + 1} local processing`, { x: 20, y: 110, size: 10, font });
  });
  return file(await document.save());
}

test.beforeEach(async ({ page }) => {
  const seen = []; requests.set(page, seen);
  page.on('request', request => seen.push({ url: request.url(), method: request.method() }));
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.goto('/');
});
test.afterEach(async ({ page }) => {
  const network = requests.get(page);
  expect(network.filter(request => request.method !== 'GET')).toEqual([]);
  expect(network.filter(request => !request.url.startsWith('http://127.0.0.1:4174/'))).toEqual([]);
  expect(network.filter(request => request.url.includes(encodeURIComponent('含透明的原图')) || request.url.includes(encodeURIComponent('测试.pdf')))).toEqual([]);
});

test('worker resizes ordinary PNG without stretching and flattens JPEG onto white', async ({ page }) => {
  const input = await bitmapFixture(page);
  const png = await process(page, 'image', [input], { format: 'png', width: 40, height: 40 });
  expect(png.error).toBeUndefined();
  expect(await pixels(page, png.outputs[0])).toEqual({ width: 40, height: 20, left: [0, 0, 0, 0], right: [255, 0, 0, 255] });
  const jpeg = await process(page, 'image', [input], { format: 'jpg', width: 40, quality: 100 });
  expect(jpeg.error).toBeUndefined();
  const decoded = await pixels(page, jpeg.outputs[0]);
  expect(decoded.width).toBe(40); expect(decoded.height).toBe(20);
  expect(decoded.left).toEqual([255, 255, 255, 255]);
  expect(decoded.right[0]).toBeGreaterThan(245); expect(decoded.right[1]).toBeLessThan(5);
  const webp = await process(page, 'image', [input], { format: 'webp' });
  expect(webp.error).toBeUndefined(); expect(webp.outputs[0].type).toBe('image/webp');
  expect((await pixels(page, webp.outputs[0])).left[3]).toBe(0);
});

test('worker respects EXIF orientation before fitting dimensions and strips orientation metadata', async ({ page }) => {
  const input = await bitmapFixture(page, { type: 'image/jpeg' });
  const exif = new Uint8Array([255, 225, 0, 34, 69, 120, 105, 102, 0, 0, 73, 73, 42, 0, 8, 0, 0, 0, 1, 0, 18, 1, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0]);
  input.bytes = [...input.bytes.slice(0, 2), ...exif, ...input.bytes.slice(2)];
  const result = await process(page, 'image', [input], { format: 'jpg', width: 20, quality: 95 });
  expect(result.error).toBeUndefined();
  const decoded = await pixels(page, result.outputs[0]);
  expect([decoded.width, decoded.height]).toEqual([20, 40]);
  expect(Buffer.from(result.outputs[0].bytes).includes(Buffer.from('Exif\0\0'))).toBe(false);
});

test('worker target size shrinks complex PNG with warning and combines images into one PDF', async ({ page }) => {
  const noisy = await bitmapFixture(page, { width: 256, height: 256, noise: true });
  const compressed = await process(page, 'image', [noisy], { format: 'png', targetKB: 8 });
  expect(compressed.error).toBeUndefined(); expect(compressed.outputs[0].bytes.length).toBeLessThanOrEqual(8192);
  expect(compressed.warnings.join('')).toContain('尺寸已缩小');
  const second = await bitmapFixture(page, { width: 20, height: 30 });
  const combined = await process(page, 'image', [noisy, second], { format: 'pdf', width: 100 });
  expect(combined.error).toBeUndefined(); expect(combined.outputs).toHaveLength(1);
  const document = await PDFDocument.load(Uint8Array.from(combined.outputs[0].bytes));
  expect(document.getPages().map(page => page.getSize())).toEqual([{ width: 75, height: 75 }, { width: 75, height: 112.5 }]);
});

test('worker performs real PDF merge, split, reverse extraction and selected rotation', async ({ page }) => {
  const first = await pdfFixture([240, 260]), second = await pdfFixture([280]);
  const merged = await process(page, 'pdf', [first, second], { mode: 'merge' });
  expect(merged.error).toBeUndefined();
  expect((await PDFDocument.load(Uint8Array.from(merged.outputs[0].bytes))).getPages().map(page => page.getWidth())).toEqual([240, 260, 280]);
  const split = await process(page, 'pdf', [first], { mode: 'split' });
  expect(split.error).toBeUndefined();
  const entries = unzipSync(Uint8Array.from(split.outputs[0].bytes));
  expect(Object.keys(entries)).toHaveLength(2);
  expect((await PDFDocument.load(entries['002_拆分.pdf'])).getPage(0).getWidth()).toBe(260);
  const extract = await process(page, 'pdf', [first], { mode: 'extract', pages: '2-1,2' });
  expect((await PDFDocument.load(Uint8Array.from(extract.outputs[0].bytes))).getPages().map(page => page.getWidth())).toEqual([260, 240, 260]);
  const rotate = await process(page, 'pdf', [first], { mode: 'rotate', pages: '2,2', angle: 90 });
  expect((await PDFDocument.load(Uint8Array.from(rotate.outputs[0].bytes))).getPages().map(page => page.getRotation().angle)).toEqual([0, 90]);
});

test('nested PDF.js worker extracts selectable text in requested order and rejects scans without OCR', async ({ page }) => {
  const output = await process(page, 'document', [await pdfFixture()], { mode: 'pdf_txt', pages: '2,1' });
  expect(output.error).toBeUndefined();
  const text = Buffer.from(output.outputs[0].bytes).toString('utf8');
  expect(text).toContain('Page 1 local processing'); expect(text).toContain('Page 2 local processing');
  expect(text.indexOf('Page 2')).toBeLessThan(text.indexOf('Page 1'));
  const photo = await bitmapFixture(page, { type: 'image/jpeg' });
  const scanPdf = await PDFDocument.create(), image = await scanPdf.embedJpg(Uint8Array.from(photo.bytes));
  scanPdf.addPage([80, 40]).drawImage(image, { width: 80, height: 40 });
  const scan = await process(page, 'document', [file(await scanPdf.save())], { mode: 'pdf_txt' });
  expect(scan.error).toContain('不执行全文 OCR');
  const rendered = await process(page, 'document', [file(await scanPdf.save())], { mode: 'pdf_png', dpi: 72 });
  expect(rendered.error).toBeUndefined();
  const entries = unzipSync(Uint8Array.from(rendered.outputs[0].bytes));
  const decoded = await pixels(page, { bytes: Array.from(Object.values(entries)[0]), type: 'image/png' });
  expect([decoded.width, decoded.height]).toEqual([80, 40]);
  expect(decoded.right[0]).toBeGreaterThan(245); expect(decoded.right[1]).toBeLessThan(10);
});

test('nested PDF.js worker renders PNG and JPG ZIPs at exact page dimensions and rotation', async ({ page }) => {
  const input = await pdfFixture([240, 260], { rotation: 90 });
  for (const mode of ['pdf_png', 'pdf_jpg']) {
    const result = await process(page, 'document', [input], { mode, pages: '2', dpi: 144, quality: 95 });
    expect(result.error).toBeUndefined(); expect(result.outputs[0].type).toBe('application/zip');
    const entries = unzipSync(Uint8Array.from(result.outputs[0].bytes));
    expect(Object.keys(entries)).toHaveLength(1);
    const name = Object.keys(entries)[0]; expect(name).toContain('第2页');
    const decoded = await pixels(page, { bytes: Array.from(entries[name]), type: mode === 'pdf_png' ? 'image/png' : 'image/jpeg' });
    expect([decoded.width, decoded.height]).toEqual([360, 520]); expect(decoded.left[3]).toBe(255);
    expect(decoded.left[0]).toBeGreaterThan(245); expect(decoded.left[1]).toBeLessThan(10);
    const black = await page.evaluate(async bytes => {
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)]));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0); bitmap.close();
      const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let count = 0; for (let index = 0; index < rgba.length; index += 4) if (rgba[index] < 80 && rgba[index + 1] < 80 && rgba[index + 2] < 80 && rgba[index + 3] > 200) count++;
      return count;
    }, Array.from(entries[name]));
    expect(black).toBeGreaterThan(100); // The embedded/fallback font must actually draw, not leave a blank page.
  }
});

test('worker rejects broken inputs and excessive rendered pixels before output', async ({ page }) => {
  const broken = await process(page, 'pdf', [file(new TextEncoder().encode('%PDF-1.7 truncated'))], { mode: 'merge' });
  expect(broken.error).toContain('无法读取');
  const range = await process(page, 'pdf', [await pdfFixture()], { mode: 'extract', pages: '0' });
  expect(range.error).toContain('页码超出范围');
  const huge = await PDFDocument.create(); huge.addPage([10000, 10000]);
  const over = await process(page, 'document', [file(await huge.save())], { mode: 'pdf_png', dpi: 150 });
  expect(over.error).toContain('2500 万像素');
  const svg = await process(page, 'image', [file(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), '任意.svg', 'image/svg+xml')], { format: 'png' });
  expect(svg.error).toContain('SVG');
});
