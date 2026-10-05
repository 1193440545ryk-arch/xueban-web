import {readFile, readdir, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist-web');
async function walk(folder) {
  const files = [];
  for (const entry of await readdir(folder, {withFileTypes: true})) {
    const filename = path.join(folder, entry.name);
    if (entry.isDirectory()) files.push(...await walk(filename)); else files.push(filename);
  }
  return files;
}
const files = await walk(dist);
if (!files.some(file => path.basename(file) === 'index.html')) throw new Error('Missing site entry.');
for (const file of files) {
  if (/\.(exe|py|sqlite|db|env|onnx)$/i.test(file) || /(?:access.?code|成员访问码)/i.test(file)) throw new Error('Unexpected private or large asset in web build: ' + file);
  if ((await stat(file)).size > 90 * 1024 * 1024) throw new Error('Asset exceeds release threshold: ' + file);
}
const html = await readFile(path.join(dist, 'index.html'), 'utf8');
if (/(?:src|href)=["']\/(?:assets|static)\//.test(html)) throw new Error('Absolute asset path breaks GitHub Pages project deployment.');
const repo = process.env.GITHUB_REPOSITORY;
if (repo && /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo)) {
  const manifestPath = path.join(dist, 'releases.json');
  const release = JSON.parse(await readFile(manifestPath, 'utf8'));
  // Only create a link after a matching published release has been checked by the workflow.
  if (process.env.DESKTOP_RELEASE_AVAILABLE === 'true') {
    release.url = `https://github.com/${repo}/releases/download/v${release.version}/${encodeURIComponent(release.filename)}`;
    await writeFile(manifestPath, JSON.stringify(release, null, 2));
  }
}
console.log(`Verified ${files.length} public build files; relative paths and release settings are ready.`);
