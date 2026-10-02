import { build } from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'mcpb', 'server');
fs.rmSync(outDir, { recursive: true, force: true });
await build({
  entryPoints: [path.join(root, 'mcp', 'server.js')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: path.join(outDir, 'index.js'),
  minify: false,
  logLevel: 'info',
});
fs.copyFileSync(path.join(root, 'assets', 'icon-256.png'), path.join(root, 'mcpb', 'icon.png'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const manifestPath = path.join(root, 'mcpb', 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.version = pkg.version;
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log('mcp server bundled ->', outDir);
