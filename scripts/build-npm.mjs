#!/usr/bin/env node
/**
 * Build the publishable npm package into `dist-npm/`.
 *
 * Why this exists: this repository keeps the local development identity
 * `@local/dsh-study-notes`, because a local DSH profile links this directory
 * under that name (`"@local/dsh-study-notes": "link:<this directory>"`).
 * npm needs an unscoped, publishable name, and DSH requires the bundle patch
 * row name, the Client module-loader id and the sidebar tab id to match the
 * package name. This script copies the runtime files into `dist-npm/` and
 * rewrites that identity to `dsh-study-notes`.
 *
 * Usage:
 *   npm run build:npm
 *   cd dist-npm && npm publish --tag beta
 *
 * The generated directory is disposable: never edit files there, edit the
 * repository and rebuild.
 */
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(ROOT, 'dist-npm');

const LOCAL_NAME = '@local/dsh-study-notes';
const PUBLISHED_NAME = 'dsh-study-notes';

const FILES = [
  'index.js',
  'client.js',
  'cordis.patch.yml',
  'icon.svg',
  'README.md',
  'README.en.md',
  'LICENSE',
  'CHANGELOG.md',
];

const DIRS = ['locale', 'docs/public'];

const TEXT_EXTENSIONS = new Set(['.js', '.yml', '.yaml']);

async function rewriteIdentity(file) {
  if (!TEXT_EXTENSIONS.has(path.extname(file).toLowerCase())) return 0;
  const text = await readFile(file, 'utf8');
  if (!text.includes(LOCAL_NAME)) return 0;
  const next = text.split(LOCAL_NAME).join(PUBLISHED_NAME);
  await writeFile(file, next, 'utf8');
  return 1;
}

async function collectTextFiles(dir, out = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await collectTextFiles(full, out);
    else out.push(full);
  }
  return out;
}

async function main() {
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });

  for (const name of FILES) {
    await cp(path.join(ROOT, name), path.join(DIST, name));
  }
  for (const name of DIRS) {
    await cp(path.join(ROOT, name), path.join(DIST, name), { recursive: true });
  }

  const manifestPath = path.join(DIST, 'package.json');
  const manifest = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  delete manifest.private;
  delete manifest.scripts;
  manifest.name = PUBLISHED_NAME;
  // The published package carries the DSH version requirement so the plugin
  // manager can refuse an incompatible DSH instead of failing at activation.
  // The development package intentionally omits it: a linked checkout must keep
  // working even when the author's DSH is a little ahead of the published range.
  manifest.engines = { dsh: '>=0.2.2-rc.3 <0.3.0' };
  manifest.publishConfig = { access: 'public', registry: 'https://registry.npmjs.org/' };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  let rewritten = 0;
  for (const file of await collectTextFiles(DIST)) {
    rewritten += await rewriteIdentity(file);
  }

  // Guard: nothing in the published artifact may keep the local identity.
  const leftovers = [];
  for (const file of await collectTextFiles(DIST)) {
    if (!TEXT_EXTENSIONS.has(path.extname(file).toLowerCase())) continue;
    if ((await readFile(file, 'utf8')).includes(LOCAL_NAME)) leftovers.push(path.relative(DIST, file));
  }
  if (leftovers.length > 0) {
    throw new Error('local identity left in published files: ' + leftovers.join(', '));
  }

  const checkManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (checkManifest.name !== PUBLISHED_NAME) throw new Error('unexpected published name');
  const client = await readFile(path.join(DIST, 'client.js'), 'utf8');
  if (!client.includes(`id: '${PUBLISHED_NAME}',`)) throw new Error('client loader id was not rewritten');

  console.log(`built dist-npm/ as ${PUBLISHED_NAME}@${checkManifest.version}`);
  console.log(`rewrote identity in ${rewritten} file(s)`);
  console.log('next: cd dist-npm && npm pack --dry-run && npm publish --tag beta');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
