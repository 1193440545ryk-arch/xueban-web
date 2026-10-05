import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { DOMParser } from '@xmldom/xmldom';
import { processDocument } from '../src/processors/document.js';
import { processPaper } from '../src/processors/paper.js';
import { readDocx, W, child, attr, xmlText } from '../src/processors/docx-package.js';

const M = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const txt = (s, name = '测试.txt') => new File([s], name, { type: 'text/plain' });
const p = (text, properties = '') => `<w:p>${properties}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const types = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
const styles = `<w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:styleId="Normal" w:default="1"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="Caption"/><w:basedOn w:val="Normal"/></w:style></w:styles>`;
function fixture(body, extra = {}) {
  const files = { '[Content_Types].xml': strToU8(types), 'word/document.xml': strToU8(`<w:document xmlns:w="${W}" xmlns:m="${M}"><w:body>${body}<w:sectPr/></w:body></w:document>`), 'word/styles.xml': strToU8(styles), ...extra };
  return new File([zipSync(files)], '论文.docx');
}
async function archive(blob) { return unzipSync(new Uint8Array(await blob.arrayBuffer())); }
async function convertedXml(result) { return strFromU8((await archive(result.outputs[0].blob))['word/document.xml']); }

test('TXT produces an editable Chinese DOCX with plain text retained', async () => {
  const result = await processDocument([txt('中文第一段\r\n第二段 <b>原样</b>')], { mode: 'txt_docx' });
  const xml = await convertedXml(result);
  assert.match(xml, /中文第一段/);
  assert.match(xml, /&lt;b&gt;原样&lt;\/b&gt;/);
  assert.equal(result.outputs[0].name, '测试.docx');
  await readDocx(new File([result.outputs[0].blob], 'result.docx'));
});

test('Markdown creates editable headings, table, code and list text without image relationships', async () => {
  const result = await processDocument([txt('# 标题\n\n**中文** *斜体*\n\n| 项目 | 值 |\n|---|---|\n| 温度 | 25 |\n\n```js\nconst x = 1;\n```\n\n1. 第一项\n2. 第二项\n\n![图](https://example.com/leak.png)', '示例.md')], { mode: 'md_docx' });
  const pkg = await archive(result.outputs[0].blob), xml = strFromU8(pkg['word/document.xml']);
  assert.match(xml, /Heading1/); assert.match(xml, /<w:tbl>/); assert.match(xml, /const x = 1;/);
  assert.match(xml, /1\. /); assert.match(xml, /2\. /); assert.match(xml, /图片：图，未加载/);
  assert.ok(!Object.keys(pkg).some(k => k.startsWith('word/media/')));
  assert.ok(!strFromU8(pkg['word/_rels/document.xml.rels']).includes('example.com'));
});

test('HTML previews escape raw HTML and never emit user image URLs or clickable links', async () => {
  const result = await processDocument([txt('<script>alert(1)</script>\n\n<iframe src="file:///secret"></iframe>\n\n![secret](file:///secret.png)\n\n![remote](https://example.com/secret.png)\n\n[link](https://example.com)', '恶意.md')], { mode: 'md_html' });
  const html = await result.outputs[0].blob.text();
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!/<(?:script|iframe|img|a)\b/i.test(html));
  assert.ok(!html.includes('src="file:'));
  assert.ok(!html.includes('https://example.com'));
  assert.match(html, /Content-Security-Policy/);
  const plain = await processDocument([txt('<svg onload=alert(1)>')], { mode: 'txt_html' });
  assert.match(await plain.outputs[0].blob.text(), /&lt;svg onload=alert\(1\)&gt;/);
});

test('document validation rejects mode, extension, non UTF-8 and oversized input', async () => {
  await assert.rejects(processDocument([txt('x')], { mode: 'txt_pdf' }), /方式/);
  await assert.rejects(processDocument([txt('x', 'x.docx')], { mode: 'txt_docx' }), /TXT/);
  await assert.rejects(processDocument([new File([new Uint8Array([0xff])], 'x.txt')], { mode: 'txt_docx' }), /UTF-8/);
  await assert.rejects(processDocument([{ name: 'x.txt', size: 21 * 1024 * 1024 }], { mode: 'txt_docx' }), /20 MB/);
});

test('paper preview has no outputs; apply requires source and settings from that preview', async () => {
  const file = fixture(p('普通正文'));
  const options = { action: 'preview', mode: 'format', font: '宋体', fontSize: 12, lineSpacing: 1.5, firstLineIndent: 2 };
  const preview = await processPaper([file], options);
  assert.equal(preview.outputs.length, 0); assert.equal(preview.preview.stats.changed, 1);
  assert.match(preview.preview.sourceHash, /^[a-f\d]{64}$/);
  await assert.rejects(processPaper([file], { ...options, action: 'apply' }), /重新预览/);
  await assert.rejects(processPaper([fixture(p('换了内容'))], { ...options, action: 'apply', sourceHash: preview.preview.sourceHash }), /重新预览/);
  await assert.rejects(processPaper([file], { ...options, action: 'apply', fontSize: 14, sourceHash: preview.preview.sourceHash }), /重新预览/);
  const result = await processPaper([file], { ...options, action: 'apply', sourceHash: preview.preview.sourceHash });
  assert.equal(result.outputs.length, 2);
  const pkg = await readDocx(new File([result.outputs[0].blob], 'result.docx'));
  const paragraph = child(child(pkg.xml.get('word/document.xml').documentElement, 'body'), 'p');
  assert.equal(attr(child(child(paragraph, 'pPr'), 'spacing'), 'line'), '360');
  assert.equal(attr(child(child(paragraph, 'pPr'), 'ind'), 'firstLine'), '480');
  assert.equal(attr(child(child(child(paragraph, 'r'), 'rPr'), 'rFonts'), 'eastAsia'), '宋体');
});

test('paper preserves headings, fields spanning paragraphs, revisions, math, captions, references and other package parts', async () => {
  const heading = p('已有一级标题', '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>');
  const parts = [heading, p('普通正文'), '<w:p><w:r><w:fldChar w:fldCharType="begin"/><w:instrText>TOC</w:instrText></w:r></w:p>', p('目录结果'), '<w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>', '<w:p><w:ins><w:r><w:t>修订</w:t></w:r></w:ins></w:p>', '<w:p><m:oMath><m:r><m:t>x</m:t></m:r></m:oMath></w:p>', p('图 1 题注'), '<w:tbl><w:tr><w:tc>' + p('表格文字') + '</w:tc></w:tr></w:tbl>', '<w:p><w:r><w:pict><w:txbxContent>' + p('文本框文字') + '</w:txbxContent></w:pict></w:r></w:p>', p('参考文献'), p('参考条目原文')];
  const file = fixture(parts.join(''), { 'word/header1.xml': strToU8(`<w:hdr xmlns:w="${W}">${p('页眉')}</w:hdr>`), 'word/media/sample.bin': new Uint8Array([1, 2, 3]) });
  const before = await readDocx(file), preview = await processPaper([file], { mode: 'format' });
  assert.equal(preview.preview.stats.changed, 1); assert.equal(preview.preview.stats.headings, 1);
  const result = await processPaper([file], { action: 'apply', mode: 'format', sourceHash: preview.preview.sourceHash });
  const after = await readDocx(new File([result.outputs[0].blob], 'out.docx'));
  const beforeBody = child(before.xml.get('word/document.xml').documentElement, 'body'), afterBody = child(after.xml.get('word/document.xml').documentElement, 'body');
  const origNodes = Array.from(beforeBody.childNodes), newNodes = Array.from(afterBody.childNodes);
  for (let i = 0; i < origNodes.length; i++) if (i !== 1) assert.equal(xmlText(newNodes[i]), xmlText(origNodes[i]));
  for (const name of Object.keys(before.files)) if (name !== 'word/document.xml') assert.deepEqual(after.files[name], before.files[name]);
});

test('cleanup trims only trailing half/full width spaces across runs and preserves leading whitespace, empty paragraphs and tabs', async () => {
  const source = fixture('<w:p><w:r><w:t xml:space="preserve">  开头 正文 </w:t></w:r><w:r><w:t xml:space="preserve">　 </w:t></w:r></w:p>' + p('　 ') + '<w:p><w:r><w:t>含制表符 </w:t><w:tab/></w:r></w:p>');
  const preview = await processPaper([source], { mode: 'cleanup' });
  assert.equal(preview.preview.stats.changed, 1); assert.equal(preview.preview.stats.spacesRemoved, 3);
  assert.equal(preview.preview.changes[0].after, '  开头 正文');
  const result = await processPaper([source], { mode: 'cleanup', action: 'apply', sourceHash: preview.preview.sourceHash });
  const xml = await convertedXml(result);
  assert.match(xml, /  开头 正文/); assert.match(xml, /含制表符 /); assert.match(xml, /<w:tab\/>/);
});

test('DOCX preflight rejects DTD, automatic external links, dangerous fields, macros and malformed XML', async () => {
  const dtd = fixture(p('ok'), { 'word/custom.xml': strToU8('<!DOCTYPE x [<!ENTITY y "secret">]><x>&y;</x>') });
  await assert.rejects(readDocx(dtd), /DTD/);
  const external = fixture(p('ok'), { 'word/_rels/document.xml.rels': strToU8(`<Relationships xmlns="${REL}"><Relationship Id="x" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://example.com/leak" TargetMode="External"/></Relationships>`) });
  await assert.rejects(readDocx(external), /外部资源/);
  const field = fixture('<w:p><w:r><w:instrText>INCLUDE</w:instrText></w:r><w:r><w:instrText>TEXT</w:instrText></w:r></w:p>');
  await assert.rejects(readDocx(field), /链接域/);
  await assert.rejects(readDocx(fixture(p('x'), { 'word/vbaProject.bin': new Uint8Array([1]) })), /宏/);
  await assert.rejects(readDocx(fixture(p('x'), { 'word/custom.xml': strToU8('<a><b></a>') })));
});

test('DOCX ZIP preflight rejects traversal, duplicate entries, excessive expansion and corruption before editing', async () => {
  await assert.rejects(readDocx(fixture(p('x'), { '../evil.xml': strToU8('<x/>') })), /路径/);
  await assert.rejects(readDocx(fixture(p('x'), { 'word/big.xml': strToU8('a'.repeat(3 * 1024 * 1024)) })), /压缩比例/);
  const source = fixture(p('x'), { 'word/aa.xml': strToU8('<a/>'), 'word/bb.xml': strToU8('<b/>') });
  const bytes = new Uint8Array(await source.arrayBuffer()), from = strToU8('word/bb.xml'), to = strToU8('word/aa.xml');
  for (let i = 0; i <= bytes.length - from.length; i++) if (from.every((b, j) => bytes[i + j] === b)) bytes.set(to, i);
  await assert.rejects(readDocx(new File([bytes], 'duplicate.docx')), /重复/);
  const broken = new Uint8Array(await fixture(p('test')).arrayBuffer());
  broken[0] = 0;
  await assert.rejects(readDocx(new File([broken], 'broken.docx')), /文件头/);
});

test('DOCX rejects illegal XML characters including decoded character references', async () => {
  for (const xml of ['<x>\u0000</x>', '<x>&#0;</x>', '<x a="&#xFFFF;"/>', '<x>&#xD800;</x>']) {
    await assert.rejects(readDocx(fixture(p('x'), { 'word/extra.xml': strToU8(xml) })), /非法字符/);
  }
  await assert.rejects(processDocument([txt('正文\ufffe')], { mode: 'txt_docx' }), /控制字符/);
});
