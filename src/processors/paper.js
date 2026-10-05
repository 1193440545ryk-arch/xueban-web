import { W, elements, child, attr, walk, xmlText, readDocx, saveDocx, sha256, escapeHtml, baseName } from './docx-package.js';

const P_ORDER = ['pStyle', 'keepNext', 'keepLines', 'pageBreakBefore', 'framePr', 'widowControl', 'numPr', 'suppressLineNumbers', 'pBdr', 'shd', 'tabs', 'suppressAutoHyphens', 'kinsoku', 'wordWrap', 'overflowPunct', 'topLinePunct', 'autoSpaceDE', 'autoSpaceDN', 'bidi', 'adjustRightInd', 'snapToGrid', 'spacing', 'ind', 'contextualSpacing', 'mirrorIndents', 'suppressOverlap', 'jc', 'textDirection', 'textAlignment', 'textboxTightWrap', 'outlineLvl', 'divId', 'cnfStyle', 'rPr', 'sectPr', 'pPrChange'];
const R_ORDER = ['rStyle', 'rFonts', 'b', 'bCs', 'i', 'iCs', 'caps', 'smallCaps', 'strike', 'dstrike', 'outline', 'shadow', 'emboss', 'imprint', 'noProof', 'snapToGrid', 'vanish', 'webHidden', 'color', 'spacing', 'w', 'kern', 'position', 'sz', 'szCs', 'highlight', 'u', 'effect', 'bdr', 'shd', 'fitText', 'vertAlign', 'rtl', 'cs', 'em', 'lang', 'eastAsianLayout', 'specVanish', 'oMath', 'rPrChange'];
function ensure(parent, name, order) {
  let node = child(parent, name);
  if (node) return node;
  node = parent.ownerDocument.createElementNS(W, 'w:' + name);
  const after = elements(parent).find(n => n.namespaceURI === W && order.indexOf(n.localName) > order.indexOf(name));
  parent.insertBefore(node, after || null);
  return node;
}
function set(node, name, value) { node.setAttributeNS(W, 'w:' + name, String(value)); }
function settingValues(options) {
  if (!options || !['preview', 'apply'].includes(options.action ?? 'preview') || !['format', 'cleanup'].includes(options.mode ?? 'format')) throw new Error('论文处理方式无效。');
  const values = { mode: options.mode ?? 'format', font: options.font ?? '宋体', fontSize: options.fontSize ?? 12, lineSpacing: options.lineSpacing ?? 1.5, firstLineIndent: options.firstLineIndent ?? 2 };
  if (typeof values.font !== 'string' || !values.font.trim() || values.font.length > 80 || /[\x00-\x1f]/.test(values.font)) throw new Error('字体名称无效。');
  values.font = values.font.trim();
  for (const [key, low, high] of [['fontSize', 6, 36], ['lineSpacing', 1, 3], ['firstLineIndent', 0, 4]]) {
    if (typeof values[key] !== 'number' || !Number.isFinite(values[key]) || values[key] < low || values[key] > high) throw new Error('排版数值超出范围。');
  }
  return values;
}
function textOf(p) {
  let text = '';
  walk(p, n => { if (n.namespaceURI === W && n.localName === 't') text += n.textContent || ''; });
  return text;
}
function styleInfo(p, styles) {
  const ppr = child(p, 'pPr'), chain = [];
  let id = attr(child(ppr, 'pStyle'), 'val') || styles.defaultId;
  const seen = new Set();
  while (id && styles.map.has(id) && !seen.has(id)) {
    seen.add(id);
    const s = styles.map.get(id);
    chain.push(s);
    id = attr(child(s, 'basedOn'), 'val');
  }
  const names = chain.map(s => `${attr(s, 'styleId')} ${attr(child(s, 'name'), 'val')}`).join(' ').toLowerCase();
  const properties = [ppr, ...chain.map(s => child(s, 'pPr'))].filter(Boolean);
  let heading = 0;
  for (const s of chain) {
    const match = /^(?:heading|标题)\s*([1-9])$/i.exec(attr(child(s, 'name'), 'val')) || /^(?:heading|标题)\s*([1-9])$/i.exec(attr(s, 'styleId'));
    if (match) { heading = Number(match[1]); break; }
  }
  for (const pr of properties) {
    const outline = child(pr, 'outlineLvl');
    if (outline && /^\d$/.test(attr(outline, 'val')) && Number(attr(outline, 'val')) < 9) heading ||= Number(attr(outline, 'val')) + 1;
  }
  const special = /toc|目录|caption|题注|bibliography|reference|参考文献|书目|list|列表|title|标题|quote|引文|footnote|endnote/.test(names);
  const normal = !attr(child(ppr, 'pStyle'), 'val') || chain.some(s => /^(?:normal|body\s*text|正文|普通)$/i.test(attr(child(s, 'name'), 'val')) || /^(?:normal|bodytext)$/i.test(attr(s, 'styleId')));
  return { heading, special, normal, numbered: properties.some(pr => child(pr, 'numPr')) };
}
function protectedRanges(body) {
  const protectedSet = new Set(), moves = new Set();
  let fields = 0;
  function visit(node, paragraph = null) {
    if (node.namespaceURI === W && node.localName === 'txbxContent') return;
    if (node.namespaceURI === W && node.localName === 'p') {
      paragraph = node;
      if (fields || moves.size) protectedSet.add(paragraph);
    }
    if (node.namespaceURI === W && node.localName === 'fldChar') {
      if (paragraph) protectedSet.add(paragraph);
      const kind = attr(node, 'fldCharType');
      if (kind === 'begin') fields++;
      if (kind === 'end') fields = Math.max(0, fields - 1);
    }
    if (node.namespaceURI === W && /^(?:moveFrom|moveTo)Range(?:Start|End)$/.test(node.localName)) {
      const key = node.localName.replace(/(?:Start|End)$/, '') + attr(node, 'id');
      if (node.localName.endsWith('Start')) moves.add(key); else moves.delete(key);
      if (paragraph) protectedSet.add(paragraph);
    }
    for (const next of elements(node)) visit(next, paragraph);
  }
  visit(body);
  return protectedSet;
}
function safeParagraph(p, body, info, protectedSet) {
  if (p.parentNode !== body || protectedSet.has(p) || info.heading || info.special || !info.normal || info.numbered) return false;
  let safe = true;
  const blocked = new Set(['drawing', 'pict', 'object', 'sdt', 'ins', 'del', 'moveFrom', 'moveTo', 'fldSimple', 'fldChar', 'instrText', 'pPrChange', 'rPrChange', 'sectPr', 'txbxContent', 'hyperlink', 'bookmarkStart', 'bookmarkEnd', 'commentRangeStart', 'commentRangeEnd', 'commentReference', 'footnoteReference', 'endnoteReference', 'vertAlign', 'sym', 'ptab', 'br', 'cr', 'tab', 'smartTag', 'customXml', 'permStart', 'permEnd']);
  walk(p, n => { if (n.namespaceURI !== W || blocked.has(n.localName)) safe = false; });
  return safe;
}
function applyFont(rpr, values) {
  const fonts = ensure(rpr, 'rFonts', R_ORDER);
  for (const key of ['asciiTheme', 'hAnsiTheme', 'eastAsiaTheme', 'cstheme', 'csTheme']) fonts.removeAttributeNS(W, key);
  for (const key of ['ascii', 'hAnsi', 'eastAsia', 'cs']) set(fonts, key, values.font);
  for (const name of ['sz', 'szCs']) set(ensure(rpr, name, R_ORDER), 'val', Math.round(values.fontSize * 2));
}
function formatParagraph(p, values) {
  const ppr = ensure(p, 'pPr', ['pPr', 'r']);
  set(ensure(ppr, 'spacing', P_ORDER), 'line', Math.round(values.lineSpacing * 240));
  set(child(ppr, 'spacing'), 'lineRule', 'auto');
  const indent = ensure(ppr, 'ind', P_ORDER);
  for (const key of ['firstLineChars', 'hanging', 'hangingChars']) indent.removeAttributeNS(W, key);
  set(indent, 'firstLine', Math.round(values.firstLineIndent * values.fontSize * 20));
  set(ensure(ppr, 'snapToGrid', P_ORDER), 'val', '0');
  applyFont(ensure(ppr, 'rPr', P_ORDER), values);
  for (const r of elements(p).filter(n => n.namespaceURI === W && n.localName === 'r')) {
    if (child(r, 't')) applyFont(ensure(r, 'rPr', ['rPr', 't']), values);
  }
}
function trimEnd(p) {
  const nodes = [];
  walk(p, n => { if (n.namespaceURI === W && n.localName === 't') nodes.push(n); });
  // Keep intentional blank paragraphs and leading indentation.
  if (!nodes.map(n => n.textContent).join('').trim()) return;
  for (let i = nodes.length - 1; i >= 0; i--) {
    const before = nodes[i].textContent || '', after = before.replace(/[ \u3000]+$/, '');
    if (before !== after) { nodes[i].textContent = after; nodes[i].setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve'); }
    if (after) break;
  }
}

export async function processPaper(files, options = {}, progress = () => {}) {
  if (!Array.isArray(files) || files.length !== 1) throw new Error('论文处理每次请选择一个 DOCX 文件。');
  const values = settingValues(options);
  progress(5, '正在检查 DOCX 结构与保护范围');
  const pkg = await readDocx(files[0]);
  const fileHash = await sha256(pkg.data);
  const sourceHash = await sha256(new TextEncoder().encode(fileHash + JSON.stringify(values)));
  const applying = options.action === 'apply';
  if (applying && options.sourceHash !== sourceHash) throw new Error('源文件或设置与预览不一致，请重新预览后确认。');
  const document = pkg.xml.get('word/document.xml'), body = child(document.documentElement, 'body');
  if (!body) throw new Error('DOCX 缺少正文。');
  const styles = { map: new Map(), defaultId: '' };
  const styleDoc = pkg.xml.get('word/styles.xml');
  if (styleDoc) for (const s of elements(styleDoc.documentElement)) {
    if (s.namespaceURI !== W || s.localName !== 'style' || attr(s, 'type') !== 'paragraph') continue;
    styles.map.set(attr(s, 'styleId'), s);
    if (['1', 'true'].includes(attr(s, 'default'))) styles.defaultId = attr(s, 'styleId');
  }
  const paragraphs = [];
  walk(body, n => { if (n.namespaceURI === W && n.localName === 'p') paragraphs.push(n); });
  if (paragraphs.length > 20000) throw new Error('文档超过 20000 段，请拆分后处理。');
  const ranges = protectedRanges(body), changes = [];
  const stats = { paragraphs: paragraphs.length, changed: 0, protected: 0, headings: 0, spacesRemoved: 0 };
  let referenceSection = false;
  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i], text = textOf(p), info = styleInfo(p, styles);
    if (info.heading >= 1 && info.heading <= 3) stats.headings++;
    if (/^(?:参考文献|参考资料|参考书目|bibliography|references)\s*[:：]?$/i.test(text.trim())) referenceSection = true;
    const caption = /^(?:(?:图|表)\s*\d|(?:figure|fig\.?|table)\s*\d|\[\d+\])/i.test(text.trim());
    if (referenceSection || caption || !text.trim() || !safeParagraph(p, body, info, ranges)) { stats.protected++; continue; }
    const before = xmlText(p);
    if (values.mode === 'cleanup') trimEnd(p); else formatParagraph(p, values);
    if (xmlText(p) !== before) {
      stats.changed++;
      const after = textOf(p);
      stats.spacesRemoved += Math.max(0, text.length - after.length);
      if (changes.length < 60) changes.push({ label: `第 ${i + 1} 段${values.mode === 'cleanup' ? '：段尾空格' : '：正文格式'}`, before: text.slice(0, 800), after: values.mode === 'cleanup' ? after.slice(0, 800) : `${after.slice(0, 700)}\n[${values.font} ${values.fontSize} 磅，${values.lineSpacing} 倍行距，首行 ${values.firstLineIndent} 字符]` });
    }
    if (i % 50 === 0) progress(15 + Math.round(65 * (i + 1) / Math.max(1, paragraphs.length)), '正在检查普通正文段落');
  }
  const warnings = [
    '仅处理安全的普通正文；已有标题（含 1–3 级）的级别、字体和字号保持原样。',
    '表格、目录、题注、参考文献及其后续内容、域、修订、公式、文本框、批注、书签、列表和疑难段落均保留。',
    values.mode === 'cleanup' ? '清理仅删除正文段尾半角/全角空格，保留段首空格、制表符、空段及连字符。' : '排版可能改变分页；字体未安装时 Word/WPS 会替换字体，请打开副本核对。',
    '预览显示修改范围与文本摘要，不是实际分页效果。',
  ];
  const summary = `${applying ? '已处理' : '预计处理'} ${stats.changed} 段普通正文，保留 ${stats.protected} 段（含 ${stats.headings} 个已有 1–3 级标题）。`;
  const preview = { sourceHash, sourceFileHash: fileHash, changes, stats, settings: values, truncated: stats.changed > changes.length, summary, warnings };
  if (!applying) { progress(100, '预览完成，请确认后生成副本'); return { outputs: [], warnings, summary, preview }; }
  progress(85, '正在生成 DOCX 副本和报告');
  const name = baseName(files[0]), rows = changes.map(c => `<tr><td>${escapeHtml(c.label)}</td><td><pre>${escapeHtml(c.before)}</pre></td><td><pre>${escapeHtml(c.after)}</pre></td></tr>`).join('');
  const report = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>论文处理报告</title><style>body{font:16px/1.7 sans-serif;max-width:1000px;margin:30px auto;padding:20px}table{border-collapse:collapse;width:100%}td{border:1px solid #bbb;padding:8px;vertical-align:top}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body><h1>论文处理报告</h1><p>${escapeHtml(files[0].name)}</p><p>${escapeHtml(summary)}</p><ul>${warnings.map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul><p>原文件 SHA256：${fileHash}</p><p>${preview.truncated ? '下表仅展示前 60 处修改，每处文字最多 800 字符。' : '下表为修改摘要，较长段落文字已截断。'}</p><table>${rows || '<tr><td>没有符合条件的修改。</td></tr>'}</table></body></html>`;
  const blob = saveDocx(pkg, document);
  progress(100, '已生成副本，原文件未修改');
  return { outputs: [{ name: `${name}_${values.mode === 'cleanup' ? '清理' : '排版'}副本.docx`, blob }, { name: `${name}_处理报告.html`, blob: new Blob([report], { type: 'text/html;charset=utf-8' }) }], warnings, summary, preview };
}
