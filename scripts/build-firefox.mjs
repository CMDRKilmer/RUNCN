/**
 * Build script for Firefox distribution.
 * - Reuses Chrome build output (dist/).
 * - Assembles dist-firefox/ with the Firefox manifest.json and icons.
 * - Packs dist-firefox/ into dist-firefox.zip with manifest.json at the root.
 */
import { rmSync, mkdirSync, copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const srcDist = join(root, 'dist');
const outDir = join(root, 'dist-firefox');
const publicDir = join(root, 'public');

function copyDirContents(src, dst, ignore = new Set()) {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (ignore.has(entry.name)) continue;
    const s = join(src, entry.name);
    const d = join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDirContents(s, d, ignore);
    } else {
      copyFileSync(s, d);
    }
  }
}

if (!existsSync(srcDist)) {
  console.error('dist/ not found. Run `pnpm run build` first.');
  process.exit(1);
}

if (existsSync(outDir)) {
  rmSync(outDir, { recursive: true, force: true });
}
mkdirSync(outDir, { recursive: true });

// Copy all built artifacts from dist/ (skip manifests — we generate manifest.json below).
// manifest.firefox.json is a stale copy vite may leave in dist/ from a previous build.
copyDirContents(srcDist, outDir, new Set(['manifest.json', 'manifest.firefox.json']));

// Generate the Firefox manifest from the built manifest.json source
// (its version is bumped by the release workflow before this runs):
// - drop the Chrome-only minimum_chrome_version
// - ensure host_permissions end with /* (Firefox requires an explicit path)
// - add the Firefox-specific browser_specific_settings
const manifest = JSON.parse(readFileSync(join(srcDist, 'manifest.json'), 'utf8'));
delete manifest.minimum_chrome_version;
manifest.host_permissions = manifest.host_permissions.map((p) =>
  p === '<all_urls>' || p.endsWith('/*') ? p : p.endsWith('/') ? `${p}*` : `${p}/*`,
);
manifest.browser_specific_settings = {
  gecko: {
    id: 'liuli-tools@runcn.local',
    strict_min_version: '118.0',
  },
};
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

// Copy icons explicitly.
const iconsDir = join(publicDir, 'icons');
const outIconsDir = join(outDir, 'icons');
mkdirSync(outIconsDir, { recursive: true });
for (const f of ['icon16.png', 'icon32.png', 'icon48.png', 'icon128.png']) {
  copyFileSync(join(iconsDir, f), join(outIconsDir, f));
}

console.log(`Firefox build ready: ${outDir}`);

// Pack into a zip with manifest.json at the archive root.
const zipPath = join(root, 'dist-firefox.zip');
if (existsSync(zipPath)) {
  rmSync(zipPath);
}

let packer;
if (process.platform === 'win32') {
  // PowerShell Compress-Archive: each file is stored at archive root,
  // preserving the manifest.json path that Firefox expects.
  packer = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path '${outDir}\\*' -DestinationPath '${zipPath}' -Force`,
    ],
    { stdio: 'inherit' },
  );
} else {
  // Unix: the `zip` CLI stores paths relative to its working directory.
  packer = spawnSync('zip', ['-r', zipPath, '.'], { cwd: outDir, stdio: 'inherit' });
}

if (packer.status !== 0) {
  console.error('Failed to create dist-firefox.zip');
  process.exit(packer.status ?? 1);
}

console.log(`Packed: ${zipPath}`);