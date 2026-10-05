import { unzipSync, zipSync } from 'fflate';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';

export const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const MAX_INPUT = 20 * 1024 * 1024;
const MAX_EXPANDED = 100 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });
const crcTable = Array.from({ length: 256 }, (_, i) => {
  for (let j = 0; j < 8; j++) i = (i >>> 1) ^ ((i & 1) ? 0xedb88320 : 0);
  return i >>> 0;
});
function crc32(data) {
  let value = 0xffffffff;
  for (const byte of data) value = (value >>> 8) ^ crcTable[(value ^ byte) & 255];
  return (value ^ 0xffffffff) >>> 0;
}
export function elements(node) {
  return Array.from(node?.childNodes || []).filter(n => n.nodeType === 1);
}
export function child(node, name) {
  return elements(node).find(n => n.namespaceURI === W && n.localName === name);
}
export function attr(node, name) { return node?.getAttributeNS(W, name) || ''; }
export function walk(root, visit) {
  const pending = [[root, 0]];
  let count = 0;
  while (pending.length) {
    const [node, depth] = pending.pop();
    if (++count > 250000 || depth > 120) throw new Error('DOCX XML 结构过于复杂，请拆分文档。');
    visit(node);
    const kids = elements(node);
    for (let i = kids.length - 1; i >= 0; i--) pending.push([kids[i], depth + 1]);
  }
}
export function xmlText(node) { return new XMLSerializer().serializeToString(node); }
function parseXml(bytes) {
  let text;
  try { text = decoder.decode(bytes); } catch { throw new Error('DOCX XML 编码不受支持，请在 Word/WPS 中另存为 DOCX。'); }
  const invalidCharacters = value => {
    for (const character of value || '') {
      const cp = character.codePointAt(0);
      if ((cp < 32 && ![9, 10, 13].includes(cp)) || (cp >= 0xd800 && cp <= 0xdfff) || cp === 0xfffe || cp === 0xffff) return true;
    }
    return false;
  };
  if (invalidCharacters(text)) throw new Error('DOCX XML 含非法字符，请另存后重试。');
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text)) throw new Error('DOCX 不允许包含 DTD 或外部实体。');
  let invalid = false;
  const doc = new DOMParser({ onError: () => { invalid = true; } }).parseFromString(text, 'application/xml');
  if (invalid || !doc?.documentElement) throw new Error('DOCX XML 已损坏，请另存后重试。');
  let fields = '';
  walk(doc.documentElement, node => {
    // xmldom accepts some invalid XML character references; validate their decoded values too.
    if (Array.from(node.attributes || []).some(a => invalidCharacters(a.value)) || Array.from(node.childNodes || []).some(n => [3, 4].includes(n.nodeType) && invalidCharacters(n.data))) throw new Error('DOCX XML 含非法字符引用，请另存后重试。');
    const name = node.localName;
    if (['altChunk', 'OLEObject', 'object', 'control'].includes(name)) throw new Error('暂不处理含外部内容、嵌入对象或控件的 DOCX。');
    if (name === 'Override' && /macroenabled/i.test(node.getAttribute('ContentType'))) throw new Error('不支持含宏的 DOCX。');
    if (node.namespaceURI === REL && name === 'Relationship') {
      const target = node.getAttribute('Target') || '';
      const external = (node.getAttribute('TargetMode') || '').toLowerCase() === 'external';
      if (external) {
        if (!(node.getAttribute('Type') || '').endsWith('/hyperlink') || !/^(?:https?:|mailto:)/i.test(target.trim())) {
          throw new Error('DOCX 含自动加载的外部资源或本地文件链接，请移除后重试。');
        }
      } else {
        let decoded;
        try { decoded = decodeURIComponent(target); } catch { throw new Error('DOCX 内部关系路径无效。'); }
        if (/^[a-z][a-z\d+.-]*:|^[\/\\]|\\/i.test(decoded)) throw new Error('DOCX 内部关系不能引用外部地址。');
      }
    }
    if (node.namespaceURI === W && name === 'instrText') fields += node.textContent || '';
    if (node.namespaceURI === W && name === 'fldSimple') fields += ' ' + attr(node, 'instr');
  });
  if (/\b(?:INCLUDETEXT|INCLUDEPICTURE|DDEAUTO|DDE|LINK|DATABASE)\b/i.test(fields)) {
    throw new Error('DOCX 含外部内容或数据链接域，请移除后重试。');
  }
  return doc;
}

// Inspect central-directory sizes before inflation; never trust filename maps to detect duplicates.
function inspectZip(data) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const u16 = p => view.getUint16(p, true), u32 = p => view.getUint32(p, true);
  let end = -1;
  for (let p = data.length - 22; p >= Math.max(0, data.length - 65557); p--) {
    if (u32(p) === 0x06054b50 && p + 22 + u16(p + 20) === data.length) { end = p; break; }
  }
  if (end < 0 || u16(end + 4) || u16(end + 6) || u16(end + 8) !== u16(end + 10)) throw new Error('DOCX ZIP 结构损坏或不受支持。');
  const count = u16(end + 10), size = u32(end + 12), offset = u32(end + 16);
  if (!count || count > 2000 || offset + size !== end) throw new Error('DOCX 内部文件数量或 ZIP 结构超出限制。');
  const entries = new Map();
  let cursor = offset, total = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || u32(cursor) !== 0x02014b50) throw new Error('DOCX ZIP 文件目录无效。');
    const flags = u16(cursor + 8), method = u16(cursor + 10), compressed = u32(cursor + 20), expanded = u32(cursor + 24);
    const length = u16(cursor + 28), extra = u16(cursor + 30), comment = u16(cursor + 32), local = u32(cursor + 42);
    if (cursor + 46 + length + extra + comment > end) throw new Error('DOCX ZIP 文件目录不完整。');
    const name = decoder.decode(data.subarray(cursor + 46, cursor + 46 + length));
    const parts = name.split('/');
    if (!name || /[\\:\x00-\x1f]/.test(name) || name.startsWith('/') || parts.some(p => p === '.' || p === '..') || entries.has(name.toLowerCase())) throw new Error('DOCX 包含不安全路径或重复内部文件。');
    if ((flags & 1) || ![0, 8].includes(method) || u16(cursor + 34) || ((u32(cursor + 38) >>> 16) & 0xf000) === 0xa000) throw new Error('不支持加密、链接或特殊压缩的 DOCX。');
    if (/vbaproject|\/embeddings\/|\/activex\/|_xmlsignatures\//i.test(name)) throw new Error('不支持含宏、嵌入对象、控件或数字签名的 DOCX。');
    total += expanded;
    if (total > MAX_EXPANDED || expanded > 30 * 1024 * 1024 || expanded > Math.max(2 * 1024 * 1024, compressed * 500) || (/\.(?:xml|rels)$/i.test(name) && expanded > 15 * 1024 * 1024)) throw new Error('DOCX 解压内容或压缩比例超出安全限制。');
    if (local + 30 > offset || u32(local) !== 0x04034b50 || u16(local + 6) !== flags || u16(local + 8) !== method) throw new Error('DOCX ZIP 本地文件头无效。');
    const dataOffset = local + 30 + u16(local + 26) + u16(local + 28);
    if (dataOffset + compressed > offset || decoder.decode(data.subarray(local + 30, local + 30 + u16(local + 26))) !== name) throw new Error('DOCX ZIP 文件数据不一致。');
    entries.set(name.toLowerCase(), { name, expanded, crc: u32(cursor + 16), local, end: dataOffset + compressed });
    cursor += 46 + length + extra + comment;
  }
  if (cursor !== end) throw new Error('DOCX ZIP 目录长度不一致。');
  const ranges = [...entries.values()].sort((a, b) => a.local - b.local);
  if (ranges.some((entry, i) => i && entry.local < ranges[i - 1].end)) throw new Error('DOCX ZIP 文件数据重叠。');
  return entries;
}

export async function readDocx(file) {
  if (!file || !/\.docx$/i.test(file.name || '') || file.size <= 0 || file.size > MAX_INPUT) throw new Error('请选择不超过 20 MB 的 DOCX 文件。');
  const data = new Uint8Array(await file.arrayBuffer());
  const entries = inspectZip(data);
  const files = unzipSync(data);
  if (!files['[Content_Types].xml'] || !files['word/document.xml']) throw new Error('文件不是有效的 DOCX。');
  const xml = new Map();
  for (const entry of entries.values()) {
    const bytes = files[entry.name];
    if (!bytes || bytes.length !== entry.expanded || crc32(bytes) !== entry.crc) throw new Error('DOCX 内部文件校验失败，文件可能损坏。');
    if (/\.(?:xml|rels)$/i.test(entry.name)) xml.set(entry.name, parseXml(bytes));
  }
  if (xml.get('word/document.xml').documentElement.namespaceURI !== W) throw new Error('暂不支持此 DOCX XML 格式，请用 Word/WPS 另存后重试。');
  return { data, files, xml };
}
export function saveDocx(packageData, document) {
  return new Blob([zipSync({ ...packageData.files, 'word/document.xml': new TextEncoder().encode(xmlText(document)) }, { level: 6 })], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}
export async function sha256(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
export function baseName(file) { return (file.name || '文档').replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '').replace(/[\x00-\x1f<>:"|?*]/g, '_').slice(0, 90) || '文档'; }
