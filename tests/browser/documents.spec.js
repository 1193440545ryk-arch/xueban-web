import { test, expect } from '@playwright/test';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { W, child, attr, xmlText, readDocx } from '../../src/processors/docx-package.js';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const p = (text, properties = '') => `<w:p>${properties}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
function paperFixture({ unsafe = false } = {}) {
  const files = {
    '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    'word/styles.xml': strToU8(`<w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:styleId="Normal" w:default="1"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/></w:style></w:styles>`),
    'word/header1.xml': strToU8(`<w:hdr xmlns:w="${W}">${p('页眉不变')}</w:hdr>`),
  };
  const heading = p('原有标题', '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>');
  const field = '<w:p><w:r><w:fldChar w:fldCharType="begin"/><w:instrText>TOC</w:instrText></w:r></w:p>' + p('目录结果') + '<w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>';
  const math = '<w:p><m:oMath><m:r><m:t>x+y</m:t></m:r></m:oMath></w:p>';
  const revision = '<w:p><w:ins w:id="1"><w:r><w:t>修订内容</w:t></w:r></w:ins></w:p>';
  files['word/document.xml'] = strToU8(`<w:document xmlns:w="${W}" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><w:body>${heading}${p('唯一普通正文  ')}${field}${math}${revision}<w:tbl><w:tr><w:tc>${p('表格内容')}</w:tc></w:tr></w:tbl>${p('图 1 题注')}${p('参考文献')}${p('参考条目不变')}<w:sectPr/></w:body></w:document>`);
  if (unsafe) files['word/extra.xml'] = strToU8('<!DOCTYPE x [<!ENTITY leak SYSTEM "https://example.invalid/secret">]><x>&leak;</x>');
  return Buffer.from(zipSync(files));
}
async function newestDone(page) {
  const card = page.locator('.task-card').first();
  await expect(card).toHaveAttribute('data-status', 'done', { timeout: 30000 });
  return card;
}
async function convert(page, mode, name, text) {
  await page.locator('[data-tab="document"]').click();
  await page.locator('#document-mode').selectOption(mode);
  await page.locator('#document-files').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(text, 'utf8') });
  await page.locator('#document-form button[type="submit"]').click();
  return newestDone(page);
}
async function downloadBytes(page, card, index = 0) {
  const pending = page.waitForEvent('download');
  await card.locator(`[data-task-action="download"][data-output="${index}"]`).click();
  const download = await pending, stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return { name: download.suggestedFilename(), buffer: Buffer.concat(chunks) };
}
test.beforeEach(async ({ page }) => { await page.goto('/'); });

test('real worker converts TXT and Markdown to editable DOCX through the UI', async ({ page }) => {
  const plain = await convert(page, 'txt_docx', '中文文本.txt', '中文正文\n第二行 <b>原样</b>');
  const txtResult = await downloadBytes(page, plain);
  expect(txtResult.name).toBe('中文文本.docx');
  const txtXml = strFromU8(unzipSync(txtResult.buffer)['word/document.xml']);
  expect(txtXml).toContain('中文正文');
  expect(txtXml).toContain('&lt;b&gt;原样&lt;/b&gt;');
  await readDocx(new File([txtResult.buffer], txtResult.name));

  const md = await convert(page, 'md_docx', 'Markdown示例.md', '# 已有标题\n\n**加粗中文**\n\n| 项目 | 结果 |\n|---|---|\n| 甲 | 42 |\n\n```js\nconst value = 42;\n```\n\n![图](https://example.invalid/should-not-load.png)');
  const mdResult = await downloadBytes(page, md);
  const pkg = unzipSync(mdResult.buffer), xml = strFromU8(pkg['word/document.xml']);
  expect(xml).toContain('Heading1'); expect(xml).toContain('<w:tbl>'); expect(xml).toContain('const value = 42;');
  expect(xml).toContain('图片：图，未加载');
  expect(strFromU8(pkg['word/_rels/document.xml.rels'])).not.toContain('example.invalid');
});

test('Markdown print preview is isolated and raw HTML/images never execute or fetch', async ({ page, context }) => {
  const outbound = [], dialogs = [];
  context.on('request', request => { if (request.url().includes('example.invalid')) outbound.push(request.url()); });
  context.on('page', popup => popup.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); }));
  const card = await convert(page, 'md_html', '安全预览.md', '# 中文打印预览\n\n<script>alert("unsafe")</script>\n\n<iframe src="https://example.invalid/iframe"></iframe>\n\n![图片](https://example.invalid/image.png)\n\n[链接](https://example.invalid/link)\n\n| 列 | 值 |\n|---|---|\n|甲|乙|');
  const pending = page.waitForEvent('popup');
  await card.locator('[data-task-action="print"]').click();
  const popup = await pending;
  await expect(popup.locator('iframe')).toHaveAttribute('sandbox', 'allow-same-origin allow-modals');
  const frame = popup.frameLocator('iframe');
  await expect(frame.locator('body')).toContainText('中文打印预览');
  await expect(frame.locator('body')).toContainText('<script>alert("unsafe")</script>');
  await expect(frame.locator('script, iframe, img, a')).toHaveCount(0);
  await expect(frame.locator('table')).toHaveCount(1);
  expect(await frame.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')).toContain("default-src 'none'");
  expect(dialogs).toEqual([]); expect(outbound).toEqual([]);
  await expect(popup.getByRole('button', { name: '打印 / 保存为 PDF' })).toBeVisible();
  await popup.close();
});

test('paper UI requires preview then applies its original settings while preserving protected structures', async ({ page }) => {
  const source = paperFixture();
  await page.locator('[data-tab="paper"]').click();
  await page.locator('#paper-files').setInputFiles({ name: '结构保护.docx', mimeType: DOCX, buffer: source });
  await page.locator('#paper-form button[type="submit"]').click();
  const preview = await newestDone(page), previewId = await preview.getAttribute('data-task-id');
  await expect(preview.locator('[data-task-action="download"]')).toHaveCount(0);
  await expect(preview).toContainText('预计处理 1 段普通正文');
  await expect(preview).toContainText('已有标题');
  // Editing the form after preview must not silently change the confirmed task settings.
  await page.locator('[data-tab="paper"]').click();
  await page.locator('#paper-font-size').fill('20');
  await page.locator('[data-tab="tasks"]').click();
  await page.locator(`[data-task-id="${previewId}"] [data-task-action="apply-paper"]`).click();
  const applied = await newestDone(page);
  await expect(applied).not.toHaveAttribute('data-task-id', previewId);
  await expect(applied.locator('[data-task-action="download"]')).toHaveCount(2);
  const result = await downloadBytes(page, applied), report = await downloadBytes(page, applied, 1);
  expect(result.name).toContain('排版副本.docx'); expect(report.name).toContain('处理报告.html');
  const original = await readDocx(new File([source], 'before.docx'));
  const updated = await readDocx(new File([result.buffer], 'after.docx'));
  const beforeNodes = Array.from(child(original.xml.get('word/document.xml').documentElement, 'body').childNodes);
  const afterNodes = Array.from(child(updated.xml.get('word/document.xml').documentElement, 'body').childNodes);
  expect(afterNodes).toHaveLength(beforeNodes.length);
  for (let i = 0; i < beforeNodes.length; i++) if (i !== 1) expect(xmlText(afterNodes[i])).toBe(xmlText(beforeNodes[i]));
  expect(attr(child(child(child(afterNodes[1], 'r'), 'rPr'), 'sz'), 'val')).toBe('24');
  for (const name of Object.keys(original.files)) if (name !== 'word/document.xml') expect(updated.files[name]).toEqual(original.files[name]);
  expect(report.buffer.toString('utf8')).toContain('已处理 1 段普通正文');
});

test('unsafe DOCX is rejected by the real worker with an actionable UI error', async ({ page, context }) => {
  const requests = [];
  context.on('request', request => { if (request.url().includes('example.invalid')) requests.push(request.url()); });
  await page.locator('[data-tab="paper"]').click();
  await page.locator('#paper-files').setInputFiles({ name: '不安全结构.docx', mimeType: DOCX, buffer: paperFixture({ unsafe: true }) });
  await page.locator('#paper-form button[type="submit"]').click();
  const card = page.locator('.task-card').first();
  await expect(card).toHaveAttribute('data-status', 'failed');
  await expect(card).toContainText('DTD');
  await expect(card.locator('[data-task-action="download"], [data-task-action="apply-paper"]')).toHaveCount(0);
  expect(requests).toEqual([]);
});
