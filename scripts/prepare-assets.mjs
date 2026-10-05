import {mkdir, cp, readFile, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pdfRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));
for (const folder of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  await mkdir(path.join(root, 'public/pdfjs', folder), {recursive: true});
  await cp(path.join(pdfRoot, folder), path.join(root, 'public/pdfjs', folder), {recursive: true});
}
await cp(path.join(pdfRoot, 'LICENSE'), path.join(root, 'public/pdfjs/LICENSE'));
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const licenses = [];
await mkdir(path.join(root, 'public/licenses'), {recursive: true});
for (const name of Object.keys(manifest.dependencies)) {
  const folder = path.join(root, 'node_modules', ...name.split('/'));
  const pkg = JSON.parse(await readFile(path.join(folder, 'package.json'), 'utf8'));
  const license = {name, version: pkg.version, license: pkg.license, homepage: pkg.homepage || pkg.repository?.url || ''};
  licenses.push(license);
  for (const filename of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENSE-MIT', 'LICENSE.MIT']) {
    try { await cp(path.join(folder, filename), path.join(root, 'public/licenses', name.replaceAll('/', '-') + '-' + filename)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
await writeFile(path.join(root, 'public/licenses/dependencies.json'), JSON.stringify(licenses, null, 2));
console.log('Prepared local PDF resources and dependency notices.');
