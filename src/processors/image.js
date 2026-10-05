import { PDFDocument } from 'pdf-lib';

const MB = 1024 * 1024;
export const IMAGE_LIMITS = Object.freeze({ files: 20, bytes: 20 * MB, pixels: 25_000_000, pdfPixels: 100_000_000, outputBytes: 150 * MB });
const MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

function integer(value, fallback, minimum, maximum, label) {
  value = value ?? fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${label}应为 ${minimum}–${maximum} 的整数。`);
  return value;
}

function checkDimensions(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 32767 || height > 32767 || width * height > IMAGE_LIMITS.pixels) {
    throw new Error('图片尺寸过大或无效；单张最多 2500 万像素，单边不超过 32767 像素。');
  }
  return { width, height };
}

/** Inspect encoded headers before asking the browser to allocate decoded pixels. */
export function inspectImageHeader(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 12) throw new Error('图片文件不完整。');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset, length) => String.fromCharCode(...bytes.subarray(offset, offset + length));
  if (bytes[0] === 137 && ascii(1, 3) === 'PNG' && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10) {
    if (bytes.length < 33 || ascii(12, 4) !== 'IHDR' || view.getUint32(8) !== 13) throw new Error('PNG 文件头无效。');
    const dimensions = checkDimensions(view.getUint32(16), view.getUint32(20));
    if (bytes[24] > 8) throw new Error('暂不转换高于 8 位/通道的 PNG，以免降低位深。');
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = view.getUint32(offset);
      if (offset + length + 12 > bytes.length) throw new Error('PNG 文件不完整。');
      if (ascii(offset + 4, 4) === 'acTL') throw new Error('暂不处理动态 PNG，请先导出需要的一帧。');
      offset += length + 12;
    }
    return { ...dimensions, mime: 'image/png' };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 3 < bytes.length) {
      if (bytes[offset++] !== 0xff) throw new Error('JPEG 文件结构无效。');
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) throw new Error('JPEG 文件不完整。');
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length < 8) throw new Error('JPEG 尺寸信息无效。');
        if (bytes[offset + 2] !== 8) throw new Error('暂不处理高位深 JPEG。');
        return { ...checkDimensions(view.getUint16(offset + 5), view.getUint16(offset + 3)), mime: 'image/jpeg' };
      }
      offset += length;
    }
    throw new Error('无法读取 JPEG 尺寸。');
  }
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    if (view.getUint32(4, true) + 8 > bytes.length) throw new Error('WebP 文件不完整。');
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const kind = ascii(offset, 4), length = view.getUint32(offset + 4, true), data = offset + 8;
      if (data + length > bytes.length) throw new Error('WebP 数据不完整。');
      if (kind === 'VP8X') {
        if (length < 10) throw new Error('WebP 尺寸信息无效。');
        if (bytes[data] & 2) throw new Error('暂不处理动态 WebP，请先导出需要的一帧。');
        const width = 1 + bytes[data + 4] + (bytes[data + 5] << 8) + (bytes[data + 6] << 16);
        const height = 1 + bytes[data + 7] + (bytes[data + 8] << 8) + (bytes[data + 9] << 16);
        return { ...checkDimensions(width, height), mime: 'image/webp' };
      }
      if (kind === 'VP8 ' && length >= 10 && bytes[data + 3] === 0x9d && bytes[data + 4] === 1 && bytes[data + 5] === 0x2a) {
        return { ...checkDimensions(view.getUint16(data + 6, true) & 0x3fff, view.getUint16(data + 8, true) & 0x3fff), mime: 'image/webp' };
      }
      if (kind === 'VP8L' && length >= 5 && bytes[data] === 0x2f) {
        const bits = view.getUint32(data + 1, true);
        return { ...checkDimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1), mime: 'image/webp' };
      }
      offset = data + length + (length & 1);
    }
    throw new Error('无法读取 WebP 尺寸。');
  }
  if (ascii(0, 2) === 'BM' && bytes.length >= 26) {
    const header = view.getUint32(14, true);
    if (header === 12) return { ...checkDimensions(view.getUint16(18, true), view.getUint16(20, true)), mime: 'image/bmp' };
    if (header >= 40 && bytes.length >= 54) return { ...checkDimensions(view.getInt32(18, true), Math.abs(view.getInt32(22, true))), mime: 'image/bmp' };
  }
  throw new Error('请选择普通 JPG、PNG、WebP 或 BMP 图片；暂不支持 GIF、TIFF、HEIC、SVG 和动态图片。');
}

export function fittedSize(width, height, requestedWidth = 0, requestedHeight = 0) {
  checkDimensions(width, height);
  integer(requestedWidth, 0, 0, 6000, '宽度');
  integer(requestedHeight, 0, 0, 6000, '高度');
  const ratio = requestedWidth || requestedHeight ? Math.min(requestedWidth ? requestedWidth / width : Infinity, requestedHeight ? requestedHeight / height : Infinity) : 1;
  return checkDimensions(Math.max(1, Math.round(width * ratio)), Math.max(1, Math.round(height * ratio)));
}

function canvasAt(width, height) {
  checkDimensions(width, height);
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('浏览器无法创建图片画布，请使用新版 Chrome 或 Edge。');
  return { canvas, context };
}

async function encode(canvas, format, quality) {
  let blob;
  try { blob = await canvas.convertToBlob({ type: MIME[format], quality: quality / 100 }); }
  catch { throw new Error('图片编码失败，请降低尺寸或换一种输出格式。'); }
  if (!blob || blob.type !== MIME[format] || !blob.size) throw new Error(`当前浏览器不支持 ${format.toUpperCase()} 编码，请选择 PNG 或其他支持的格式。`);
  return blob;
}

async function fitTarget(bitmap, initial, format, quality, targetBytes) {
  let size = initial, best;
  const minimum = Math.min(35, quality);
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const { canvas, context } = canvasAt(size.width, size.height);
    try {
      if (format === 'jpg') { context.fillStyle = '#fff'; context.fillRect(0, 0, size.width, size.height); }
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(bitmap, 0, 0, size.width, size.height);
      let blob = await encode(canvas, format, quality);
      if (targetBytes && blob.size > targetBytes && format !== 'png') {
        let low = minimum, high = quality - 1;
        blob = await encode(canvas, format, minimum);
        let candidate = blob;
        while (low <= high) {
          const middle = Math.floor((low + high) / 2), test = await encode(canvas, format, middle);
          if (test.size <= targetBytes) { candidate = test; low = middle + 1; }
          else high = middle - 1;
        }
        blob = candidate;
      }
      best = { blob, ...size };
      if (!targetBytes || blob.size <= targetBytes || Math.max(size.width, size.height) <= 32 || attempt === 15) return best;
      const ratio = Math.min(0.85, Math.max(0.3, Math.sqrt(targetBytes / blob.size) * 0.93));
      size = { width: Math.max(1, Math.floor(size.width * ratio)), height: Math.max(1, Math.floor(size.height * ratio)) };
    } finally { canvas.width = canvas.height = 1; }
  }
  return best;
}

function outputStem(name, index) {
  const leaf = String(name || '图片').replaceAll('\\', '/').split('/').pop();
  const clean = leaf.replace(/\.[^.]*$/, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 70) || '图片';
  return `${String(index + 1).padStart(2, '0')}_${clean}`;
}

export async function processImage(files, options = {}, progress = () => {}) {
  if (!Array.isArray(files) || files.length < 1 || files.length > IMAGE_LIMITS.files) throw new Error('每次请选择 1–20 张图片。');
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('图片选项无效。');
  const format = options.format ?? 'jpg';
  if (!['jpg', 'png', 'webp', 'pdf'].includes(format)) throw new Error('请选择 JPG、PNG、WebP 或 PDF。');
  const quality = integer(options.quality, 85, 10, 100, '质量');
  const width = integer(options.width, 0, 0, 6000, '宽度'), height = integer(options.height, 0, 0, 6000, '高度');
  const targetKB = integer(options.targetKB, 0, 0, 51200, '目标体积');
  if (format === 'pdf' && targetKB) throw new Error('图片合成 PDF 不支持指定目标体积。');
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function' || !OffscreenCanvas.prototype.convertToBlob) throw new Error('当前浏览器不支持本地图片处理，请使用新版桌面 Chrome 或 Edge。');
  const outputs = [], warnings = [], pdf = format === 'pdf' ? await PDFDocument.create() : null;
  let outputBytes = 0, pdfPixels = 0;
  progress(1, '正在检查图片');
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    if (!file || typeof file.arrayBuffer !== 'function' || file.size < 1 || file.size > IMAGE_LIMITS.bytes) throw new Error('单张图片须大于 0 字节且不超过 20 MB。');
    const header = inspectImageHeader(new Uint8Array(await file.arrayBuffer()));
    let bitmap;
    try { bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch { throw new Error(`无法解码“${file.name || '图片'}”，请确认文件完整且当前浏览器支持该格式。`); }
    try {
      checkDimensions(bitmap.width, bitmap.height);
      if (bitmap.width * bitmap.height !== header.width * header.height) throw new Error('浏览器解码尺寸与文件头不一致，已停止处理。');
      const size = fittedSize(bitmap.width, bitmap.height, width, height);
      if (pdf) {
        pdfPixels += size.width * size.height;
        if (pdfPixels > IMAGE_LIMITS.pdfPixels) throw new Error('合成 PDF 的图片总量超过 1 亿像素，请减少图片或降低尺寸。');
      }
      progress(Math.round(5 + index / files.length * 85), `正在处理第 ${index + 1}/${files.length} 张图片`);
      const result = await fitTarget(bitmap, size, pdf ? 'png' : format, quality, targetKB * 1024);
      outputBytes += result.blob.size;
      if (outputBytes > IMAGE_LIMITS.outputBytes) throw new Error('结果总量超过 150 MB，请分批处理。');
      if (result.width !== size.width || result.height !== size.height) warnings.push(`第 ${index + 1} 张为接近目标体积，尺寸已缩小至 ${result.width} × ${result.height}。`);
      if (targetKB && result.blob.size > targetKB * 1024) warnings.push(`第 ${index + 1} 张未达到 ${targetKB} KB，保留当前结果；请提高体积上限或改用 JPG/WebP。`);
      if (pdf) {
        const picture = await pdf.embedPng(await result.blob.arrayBuffer());
        const scale = Math.min(1, 14000 / Math.max(result.width * 0.75, result.height * 0.75));
        const page = pdf.addPage([result.width * 0.75 * scale, result.height * 0.75 * scale]);
        page.drawImage(picture, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
      } else outputs.push({ name: `${outputStem(file.name, index)}.${format}`, blob: result.blob });
    } finally { bitmap.close(); }
  }
  if (pdf) {
    progress(95, '正在生成合并 PDF');
    const bytes = await pdf.save();
    if (bytes.byteLength > IMAGE_LIMITS.outputBytes) throw new Error('结果超过 150 MB，请分批处理。');
    outputs.push({ name: '图片合并.pdf', blob: new Blob([bytes], { type: 'application/pdf' }) });
  }
  warnings.push('图片经浏览器重新编码，原有 EXIF 等元数据不保留；颜色可能受浏览器色彩管理影响。');
  progress(100, '处理完成');
  return { outputs, warnings, summary: pdf ? `已按顺序将 ${files.length} 张图片合成一份 PDF。` : `已在本机处理 ${files.length} 张图片。` };
}
