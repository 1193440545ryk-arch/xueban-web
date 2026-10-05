import { PDFDocument, PDFName, PDFNumber, degrees } from 'pdf-lib';
import { zipSync } from 'fflate';

const MB = 1024 * 1024;
export const PDF_LIMITS = Object.freeze({ files: 20, inputBytes: 50 * MB, pages: 200, renderPages: 20, pagePixels: 25_000_000, renderPixels: 100_000_000, outputBytes: 150 * MB });
const EDIT_WARNING = '已生成副本，原文件不变；请核对书签、链接、表单和批注。页面复制可能不保留文档级附件与结构，数字签名会失效。';

function integer(value, fallback, low, high, label) {
  value = value ?? fallback;
  if (!Number.isSafeInteger(value) || value < low || value > high) throw new Error(`${label}应为 ${low}–${high} 的整数。`);
  return value;
}

/** 1-based inclusive ranges -> 0-based indices, preserving order and repetition. */
export function parsePages(expression = '', count, maximum = PDF_LIMITS.pages) {
  if (!Number.isSafeInteger(count) || count < 1 || count > PDF_LIMITS.pages) throw new Error('PDF 页数无效或超过 200 页。');
  if (typeof expression !== 'string' || expression.length > 4000) throw new Error('页码表达式须为不超过 4000 字符的文字。');
  const value = expression.trim().replaceAll('，', ',').replace(/[–—]/g, '-');
  if (!value) {
    if (count > maximum) throw new Error(`此次最多选择 ${maximum} 页，请填写较小的页码范围。`);
    return Array.from({ length: count }, (_, index) => index);
  }
  const pages = [];
  for (const part of value.split(',')) {
    const match = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(part);
    if (!match) throw new Error('页码格式不正确，请使用 1-3,5；不允许空分段。');
    const start = Number(match[1]), end = Number(match[2] ?? match[1]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < 1 || start > count || end > count) throw new Error(`页码超出范围，此 PDF 共 ${count} 页。`);
    if (pages.length + Math.abs(end - start) + 1 > maximum) throw new Error(`此次最多选择 ${maximum} 页，包括重复页。`);
    const step = start <= end ? 1 : -1;
    for (let index = start; index !== end + step; index += step) pages.push(index - 1);
  }
  return pages;
}

export function parseGroups(value = '', count) {
  if (typeof value !== 'string' || value.length > 4000) throw new Error('拆分分组须为不超过 4000 字符的页码表达式。');
  if (!value.trim()) return parsePages('', count).map(index => [index]);
  const expressions = value.replaceAll('；', ';').split(';');
  if (expressions.some(group => !group.trim())) throw new Error('拆分分组不允许留空，请使用 1-3;4-6。');
  const groups = expressions.map(group => parsePages(group, count));
  if (groups.reduce((sum, group) => sum + group.length, 0) > PDF_LIMITS.pages) throw new Error('拆分输出总量不能超过 200 页，包括重复页。');
  return groups;
}

function checkFiles(files, multiple) {
  if (!Array.isArray(files) || !files.length || files.length > PDF_LIMITS.files || (!multiple && files.length !== 1)) throw new Error(multiple ? '合并每次支持 1–20 份 PDF。' : '此操作每次请选择一份 PDF。');
  let bytes = 0;
  for (const file of files) {
    if (!file || typeof file.arrayBuffer !== 'function' || !Number.isSafeInteger(file.size) || file.size < 1) throw new Error('PDF 文件为空或无效。');
    bytes += file.size;
    if (bytes > PDF_LIMITS.inputBytes) throw new Error('PDF 输入总量不能超过 50 MB，请分批处理。');
  }
}

async function loadPdf(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  if (!head.includes('%PDF-')) throw new Error('文件内容不是有效的 PDF。');
  let document, count;
  try {
    document = await PDFDocument.load(bytes, { ignoreEncryption: false, updateMetadata: false, throwOnInvalidObject: true });
    count = document.getPageCount();
  }
  catch (error) {
    if (error?.name === 'EncryptedPDFError' || /encrypted/i.test(String(error))) throw new Error('暂不处理加密 PDF，请用密码打开并另存未加密副本。');
    throw new Error('无法读取 PDF，文件可能损坏或使用了不支持的结构。');
  }
  if (document.isEncrypted) throw new Error('暂不处理加密 PDF，请另存未加密副本。');
  if (count < 1 || count > PDF_LIMITS.pages) throw new Error('PDF 须为 1–200 页，请拆分后处理。');
  return { document, bytes };
}

function checkedBlob(bytes, type = 'application/pdf') {
  if (bytes.byteLength > PDF_LIMITS.outputBytes) throw new Error('结果超过 150 MB，请减少输入或页数。');
  return new Blob([bytes], { type });
}

async function copied(source, indices) {
  const document = await PDFDocument.create();
  const pages = await document.copyPages(source, indices);
  for (const page of pages) document.addPage(page);
  return document.save();
}

export async function processPdf(files, options = {}, progress = () => {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('PDF 选项无效。');
  const mode = options.mode ?? 'merge';
  if (!['merge', 'split', 'extract', 'rotate'].includes(mode)) throw new Error('请选择合并、拆分、提取或旋转；本地版不提供未经验证的压缩。');
  checkFiles(files, mode === 'merge');
  const sources = [];
  let total = 0;
  for (let index = 0; index < files.length; index += 1) {
    progress(Math.round(2 + index / files.length * 18), `正在读取第 ${index + 1}/${files.length} 份 PDF`);
    const loaded = await loadPdf(files[index]);
    total += loaded.document.getPageCount();
    if (total > PDF_LIMITS.pages) throw new Error('PDF 输入总页数不能超过 200 页。');
    sources.push(loaded.document);
  }
  let outputs, summary;
  if (mode === 'merge') {
    const result = await PDFDocument.create();
    for (let index = 0; index < sources.length; index += 1) {
      const pages = await result.copyPages(sources[index], sources[index].getPageIndices());
      pages.forEach(page => result.addPage(page));
      progress(Math.round(25 + (index + 1) / sources.length * 65), '正在按选择顺序合并 PDF');
    }
    outputs = [{ name: '合并结果.pdf', blob: checkedBlob(await result.save()) }];
    summary = `已将 ${files.length} 份 PDF 合并为 ${total} 页。`;
  } else if (mode === 'split') {
    const groups = parseGroups(options.groups ?? '', total), entries = {};
    let bytes = 0;
    for (let index = 0; index < groups.length; index += 1) {
      const content = await copied(sources[0], groups[index]);
      bytes += content.byteLength;
      if (bytes > PDF_LIMITS.outputBytes) throw new Error('拆分结果超过 150 MB，请减少输出页数。');
      entries[`${String(index + 1).padStart(3, '0')}_拆分.pdf`] = content;
      progress(Math.round(20 + (index + 1) / groups.length * 70), `正在生成第 ${index + 1}/${groups.length} 份结果`);
    }
    outputs = [{ name: 'PDF拆分结果.zip', blob: checkedBlob(zipSync(entries, { level: 0 }), 'application/zip') }];
    summary = `已拆分为 ${groups.length} 份 PDF，打包为一份 ZIP。`;
  } else if (mode === 'extract') {
    const pages = parsePages(options.pages ?? '', total);
    outputs = [{ name: '提取页面.pdf', blob: checkedBlob(await copied(sources[0], pages)) }];
    summary = `已按指定顺序提取 ${pages.length} 页。`;
  } else {
    const angle = integer(options.angle, 90, 90, 270, '旋转角度');
    if (![90, 180, 270].includes(angle)) throw new Error('旋转角度应为 90、180 或 270 度。');
    const pages = new Set(parsePages(options.pages ?? '', total));
    pages.forEach(index => {
      const page = sources[0].getPage(index);
      page.setRotation(degrees((page.getRotation().angle + angle) % 360));
    });
    outputs = [{ name: '旋转结果.pdf', blob: checkedBlob(await sources[0].save()) }];
    summary = `已顺时针旋转 ${pages.size} 页，其余页面保留。`;
  }
  progress(100, '处理完成');
  return { outputs, warnings: [EDIT_WARNING], summary };
}

export function checkRenderSizes(sizes) {
  let total = 0;
  for (const { width, height } of sizes) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || width > 32767 || height > 32767) throw new Error('PDF 页面尺寸无效或过大，请降低 DPI。');
    const pixels = Math.ceil(width) * Math.ceil(height);
    if (pixels > PDF_LIMITS.pagePixels) throw new Error('单页渲染超过 2500 万像素，请降低 DPI。');
    total += pixels;
    if (total > PDF_LIMITS.renderPixels) throw new Error('本批渲染超过 1 亿像素，请减少页数或降低 DPI。');
  }
}

class WorkerCanvasFactory {
  create(width, height) {
    checkRenderSizes([{ width, height }]);
    const canvas = new OffscreenCanvas(Math.ceil(width), Math.ceil(height));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法创建 PDF 页面画布。');
    return { canvas, context };
  }
  reset(entry, width, height) { checkRenderSizes([{ width, height }]); entry.canvas.width = Math.ceil(width); entry.canvas.height = Math.ceil(height); }
  destroy(entry) { entry.canvas.width = entry.canvas.height = 1; entry.canvas = null; entry.context = null; }
}

// SVG URL filters require a DOM and are unavailable inside a worker. Reject
// those uncommon color/mask operations instead of silently exporting bad pixels.
class WorkerFilterFactory {
  addFilter(maps) { if (maps) throw new Error('此 PDF 使用暂不支持的色彩过滤器，请使用桌面客户端导出图片。'); return 'none'; }
  addAlphaFilter() { throw new Error('此 PDF 的透明过滤器暂不支持，请使用桌面客户端导出图片。'); }
  addLuminosityFilter() { throw new Error('此 PDF 的亮度蒙版暂不支持，请使用桌面客户端导出图片。'); }
  addKnockoutFilter() { return 'none'; } // PDF.js supplies a pixel fallback.
  addHCMFilter() { return 'none'; }
  addHighlightHCMFilter() { return 'none'; }
  addSelectionHCMFilter() { return 'none'; }
  addSelectionFilter() { return 'none'; }
  createSelectionStyle() { return null; }
  destroy() {}
}

function assetsBase(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('PDF 本地组件地址未配置，请刷新网页后重试。'); }
  if (!globalThis.location || url.origin !== globalThis.location.origin || !url.pathname.endsWith('/pdfjs/') || url.search || url.hash) throw new Error('PDF 组件只允许从本站的 pdfjs 目录加载。');
  return url.href;
}

function checkEmbeddedImages(document) {
  const objects = document.context.enumerateIndirectObjects();
  if (objects.length > 100000) throw new Error('PDF 内部结构过于复杂，请拆分或使用桌面客户端。');
  for (const [, object] of objects) {
    const dict = object?.dict;
    if (dict?.get(PDFName.of('Subtype'))?.toString() !== '/Image') continue;
    const width = dict.lookupMaybe(PDFName.of('Width'), PDFNumber)?.asNumber();
    const height = dict.lookupMaybe(PDFName.of('Height'), PDFNumber)?.asNumber();
    if (width && height) checkRenderSizes([{ width, height }]);
  }
}

export async function processPdfDocument(files, options = {}, progress = () => {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('PDF 转换选项无效。');
  const mode = options.mode;
  if (!['pdf_txt', 'pdf_png', 'pdf_jpg'].includes(mode)) throw new Error('不支持的 PDF 转换类型。');
  checkFiles(files, false);
  const dpi = integer(options.dpi, 150, 72, 200, 'DPI'), quality = integer(options.quality, 85, 10, 100, '质量');
  const base = assetsBase(options.assetBase);
  if (typeof Worker !== 'function' || (mode !== 'pdf_txt' && (typeof OffscreenCanvas !== 'function' || !OffscreenCanvas.prototype.convertToBlob))) throw new Error('当前浏览器不支持本地 PDF 转换，请使用新版桌面 Chrome 或 Edge。');
  progress(1, '正在验证 PDF');
  const loaded = await loadPdf(files[0]);
  const count = loaded.document.getPageCount();
  const selection = parsePages(options.pages ?? '', count, mode === 'pdf_txt' ? PDF_LIMITS.pages : PDF_LIMITS.renderPages);
  if (mode !== 'pdf_txt') checkEmbeddedImages(loaded.document);
  loaded.document = null;
  const [pdfjs, workerAsset] = await Promise.all([
    import('pdfjs-dist/build/pdf.mjs'), import('pdfjs-dist/build/pdf.worker.mjs?url'),
  ]);
  const port = new Worker(workerAsset.default, { type: 'module', name: 'pdf-parser' });
  let task, worker;
  try {
    worker = new pdfjs.PDFWorker({ port });
    task = pdfjs.getDocument({
      data: loaded.bytes, worker,
      cMapUrl: `${base}cmaps/`, cMapPacked: true,
      iccUrl: `${base}iccs/`,
      standardFontDataUrl: `${base}standard_fonts/`, wasmUrl: `${base}wasm/`,
      useWorkerFetch: true, stopAtErrors: true, enableXfa: false, isEvalSupported: false,
      maxImageSize: PDF_LIMITS.pagePixels, canvasMaxAreaInBytes: PDF_LIMITS.pagePixels * 4,
      CanvasFactory: WorkerCanvasFactory, FilterFactory: WorkerFilterFactory,
      ownerDocument: { fonts: globalThis.fonts },
      disableFontFace: !globalThis.fonts, useSystemFonts: false,
    });
    const document = await task.promise;
    if (document.numPages !== count) throw new Error('PDF 页数解析不一致，请另存文件后重试。');
    let outputs, summary;
    const warnings = [];
    if (mode === 'pdf_txt') {
      const pages = [];
      let empty = 0, characters = 0;
      for (let order = 0; order < selection.length; order += 1) {
        const page = await document.getPage(selection[order] + 1);
        try {
          const content = await page.getTextContent();
          const text = content.items.filter(item => typeof item.str === 'string').map(item => item.str + (item.hasEOL ? '\n' : ' ')).join('').trim();
          characters += text.length;
          if (characters > 10_000_000) throw new Error('提取文字超过 1000 万字符，请减少页数。');
          if (!text) empty += 1;
          pages.push(text);
          progress(Math.round(10 + (order + 1) / selection.length * 85), `正在提取第 ${order + 1}/${selection.length} 页文字`);
        } finally { page.cleanup(); }
      }
      if (empty === pages.length) throw new Error('所选页面未检测到可提取文字，可能是扫描件；本工具不执行全文 OCR。');
      if (empty) warnings.push(`所选页面有 ${empty} 页没有可提取文字，可能需要 OCR。`);
      warnings.push('提取 PDF 已有文字，复杂排版的阅读顺序和公式可能变化，请核对。');
      outputs = [{ name: '提取文字.txt', blob: new Blob(['\ufeff', pages.join('\n\n\f\n\n')], { type: 'text/plain;charset=utf-8' }) }];
      summary = `已提取 ${selection.length} 页的已有文字。`;
    } else {
      const plans = [];
      for (const index of selection) {
        const page = await document.getPage(index + 1);
        const viewport = page.getViewport({ scale: dpi / 72 });
        plans.push({ index, width: viewport.width, height: viewport.height });
      }
      checkRenderSizes(plans); // Validate every page before creating any canvas.
      const entries = {}, type = mode === 'pdf_png' ? 'image/png' : 'image/jpeg', extension = mode === 'pdf_png' ? 'png' : 'jpg';
      let bytes = 0;
      for (let order = 0; order < plans.length; order += 1) {
        const plan = plans[order], page = await document.getPage(plan.index + 1);
        const viewport = page.getViewport({ scale: dpi / 72 });
        const factory = new WorkerCanvasFactory(), entry = factory.create(viewport.width, viewport.height);
        try {
          progress(Math.round(10 + order / plans.length * 80), `正在渲染第 ${order + 1}/${plans.length} 页`);
          await page.render({ canvasContext: entry.context, viewport, background: '#ffffff', intent: 'print' }).promise;
          const blob = await entry.canvas.convertToBlob({ type, quality: quality / 100 });
          if (blob.type !== type || !blob.size) throw new Error('当前浏览器不支持所选的图片输出格式。');
          bytes += blob.size;
          if (bytes > PDF_LIMITS.outputBytes) throw new Error('图片导出结果超过 150 MB，请减少页数或降低 DPI。');
          entries[`${String(order + 1).padStart(3, '0')}_第${plan.index + 1}页.${extension}`] = new Uint8Array(await blob.arrayBuffer());
        } finally { factory.destroy(entry); page.cleanup(); }
      }
      progress(95, '正在打包页面图片');
      outputs = [{ name: `PDF页面_${extension}.zip`, blob: checkedBlob(zipSync(entries, { level: 0 }), 'application/zip') }];
      warnings.push('每页已转为图片并打包；文字不可直接编辑。复杂色彩、表单和批注请对照原 PDF 核对。');
      summary = `已将 ${plans.length} 页导出为 ${extension.toUpperCase()} 图片并打包。`;
    }
    progress(100, '处理完成');
    return { outputs, warnings, summary };
  } finally {
    try { if (task) await task.destroy(); } finally { worker?.destroy(); port.terminate(); }
  }
}
