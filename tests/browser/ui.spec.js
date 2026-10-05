import {test, expect} from '@playwright/test';
import {PDFDocument, StandardFonts} from 'pdf-lib';
import {readFile, mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const qa = path.join(root, '.local-qa');
let server, subpathURL;

test.beforeAll(async () => {
  await mkdir(qa, {recursive: true});
  const dist = path.join(root, 'dist-web');
  server = createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      const prefix = '/xueban-demo/';
      if (!pathname.startsWith(prefix)) { res.writeHead(404).end(); return; }
      const target = path.resolve(dist, pathname.slice(prefix.length) || 'index.html');
      if (!target.startsWith(dist + path.sep)) { res.writeHead(403).end(); return; }
      const types = {'.html': 'text/html;charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.woff2': 'font/woff2'};
      res.setHeader('Content-Type', types[path.extname(target)] || 'application/octet-stream');
      res.end(await readFile(target));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  subpathURL = `http://127.0.0.1:${server.address().port}/xueban-demo/`;
});
test.afterAll(async () => { if (server) await new Promise(resolve => server.close(resolve)); });

function track(page) {
  const unexpected = [], errors = [];
  page.on('request', request => {
    if (!/^(?:http:\/\/127\.0\.0\.1:|blob:|data:)/.test(request.url()) || request.method() !== 'GET' || /\/api\//.test(request.url())) unexpected.push(request.method() + ' ' + request.url());
  });
  page.on('pageerror', error => errors.push(error.message));
  return {unexpected, errors};
}
async function imageFile(page) {
  const data = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 160;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#16715a'; ctx.fillRect(0,0,120,160);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  return {name: '测试图片.png', mimeType: 'image/png', buffer: Buffer.from(data, 'base64')};
}
async function completed(page) {
  const card = page.locator('[data-task-id]').first();
  await expect(card).toHaveAttribute('data-status', /done|failed|cancelled/);
  expect(await card.getAttribute('data-status'), await card.innerText()).toBe('done');
  return card;
}
async function download(page, card) {
  const pending = page.waitForEvent('download');
  await card.getByRole('button', {name: /下载/}).first().click();
  const item = await pending;
  return {name: item.suggestedFilename(), bytes: await readFile(await item.path())};
}

test('public UI, image worker, actual download and clear records work without uploads', async ({page}) => {
  const log = track(page);
  await page.goto('/');
  await expect(page.locator('#image-title')).toBeVisible();
  await expect(page.getByText('文件内容不发送到服务器')).toBeVisible();
  await page.screenshot({path: path.join(qa, 'home.png'), fullPage: true});
  await page.locator('#image-files').setInputFiles(await imageFile(page));
  await page.locator('#image-format').selectOption('png');
  await page.locator('#image-width').fill('120');
  await page.locator('#image-form button[type="submit"]').click();
  const card = await completed(page);
  const output = await download(page, card);
  expect(output.name).toMatch(/\.png$/);
  expect(output.bytes.readUInt32BE(16)).toBe(120);
  expect(output.bytes.readUInt32BE(20)).toBe(80);
  await page.screenshot({path: path.join(qa, 'image-result.png'), fullPage: true});
  await page.locator('#clear-tasks').click();
  await page.locator('#confirm-dialog button[value="confirm"]').click();
  await expect(page.locator('#tasks-empty')).toBeVisible();
  expect(log.unexpected).toEqual([]); expect(log.errors).toEqual([]);
});

test('PDF UI wires real merge and text extraction, including under a Pages subdirectory', async ({page}) => {
  const log = track(page);
  await page.goto(subpathURL);
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage([300, 400]).drawText('Xueban local PDF test', {font, x: 30, y: 300});
  const source = Buffer.from(await pdf.save());
  await page.locator('[data-tab="pdf"]').click();
  await page.locator('#pdf-files').setInputFiles([{name:'first.pdf',mimeType:'application/pdf',buffer:source},{name:'second.pdf',mimeType:'application/pdf',buffer:source}]);
  await page.locator('#pdf-form button[type="submit"]').click();
  let result = await download(page, await completed(page));
  expect((await PDFDocument.load(result.bytes)).getPageCount()).toBe(2);
  await page.locator('[data-tab="document"]').click();
  await page.locator('#document-mode').selectOption('pdf_txt');
  await page.locator('#document-files').setInputFiles({name:'words.pdf',mimeType:'application/pdf',buffer:source});
  await page.locator('#document-form button[type="submit"]').click();
  result = await download(page, await completed(page));
  expect(result.bytes.toString('utf8')).toContain('Xueban local PDF test');
  expect(log.unexpected).toEqual([]); expect(log.errors).toEqual([]);
});

test('formula preview, .tex save and honest release state work', async ({page}) => {
  const log = track(page);
  const manifest = JSON.parse(await readFile(path.join(root, 'public/releases.json'), 'utf8'));
  await page.route('**/releases.json', route => route.fulfill({json: {...manifest, url: ''}}));
  await page.goto('/#formula');
  await page.locator('#formula-input').fill('x=\\frac{-b+\\sqrt{b^2-4ac}}{2a}');
  await expect(page.locator('#formula-preview .katex')).toBeVisible();
  const pending = page.waitForEvent('download');
  await page.locator('#formula-save').click();
  const output = await pending;
  expect((await readFile(await output.path(), 'utf8'))).toContain('\\frac');
  await page.locator('#formula-input').fill('\\frac{');
  await expect(page.locator('#formula-error')).toBeVisible();
  await page.locator('[data-tab="download"]').click();
  await expect(page.locator('#release-unconfigured')).toBeVisible();
  await expect(page.locator('#release-link')).toBeHidden();
  await expect(page.locator('#release-sha256')).toContainText(manifest.sha256);
  const configuredURL = 'https://example.com/xueban-test-installer.exe';
  await page.unroute('**/releases.json');
  await page.route('**/releases.json', route => route.fulfill({json: {...manifest, url: configuredURL}}));
  await page.locator('#release-retry').click();
  await expect(page.locator('#release-link')).toBeVisible();
  await expect(page.locator('#release-link')).toHaveAttribute('href', configuredURL);
  await expect(page.locator('#release-unconfigured')).toBeHidden();
  expect(log.unexpected).toEqual([]); expect(log.errors).toEqual([]);
});

test('a blocked worker becomes a failed task instead of hanging', async ({page}) => {
  await page.addInitScript(() => { window.Worker = class { constructor() { throw new Error('Worker blocked for regression test'); } }; });
  await page.goto('/');
  await page.locator('#image-files').setInputFiles(await imageFile(page));
  await page.locator('#image-form button[type="submit"]').click();
  const card = page.locator('[data-task-id]').first();
  await expect(card).toHaveAttribute('data-status', 'failed');
  await expect(card).toContainText('无法启动处理组件');
});

test('cancelling a starting worker releases the queue and leaves the next task usable', async ({page, context}) => {
  let releaseFirst;
  const gate = new Promise(resolve => { releaseFirst = resolve; });
  let first = true;
  await context.route('**/processor.worker-*.js', async route => {
    if (first) { first = false; await gate; }
    try { await route.continue(); } catch { /* The cancelled worker may have already aborted its request. */ }
  });
  try {
    await page.goto('/');
    await page.locator('#image-files').setInputFiles(await imageFile(page));
    await page.locator('#image-form button[type="submit"]').click();
    const original = page.locator('[data-task-id]').first();
    await expect(original).toHaveAttribute('data-status', 'running');
    const originalId = await original.getAttribute('data-task-id');
    await original.locator('[data-task-action="cancel"]').click();
    await expect(page.locator(`[data-task-id="${originalId}"]`)).toHaveAttribute('data-status', 'cancelled');
    releaseFirst();
    await page.locator('[data-tab="image"]').click();
    await page.locator('#image-form button[type="submit"]').click();
    await completed(page);
    await expect(page.locator(`[data-task-id="${originalId}"]`)).toHaveAttribute('data-status', 'cancelled');
    await expect(page.locator('[data-task-id]')).toHaveCount(2);
  } finally { releaseFirst(); }
});
