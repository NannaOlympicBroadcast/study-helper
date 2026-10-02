import { build } from 'esbuild';
import fs from 'fs';
import path from 'path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const src = path.join(root, 'src', 'renderer');
const out = path.join(root, 'dist', 'renderer');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

await build({
  entryPoints: [path.join(src, 'app.js'), path.join(src, 'popup.js')],
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  outdir: out,
  minify: true,
  sourcemap: false,
  logLevel: 'info',
});
for (const f of ['index.html', 'popup.html', 'style.css']) fs.copyFileSync(path.join(src, f), path.join(out, f));
const katexDist = path.join(root, 'node_modules', 'katex', 'dist');
fs.mkdirSync(path.join(out, 'katex'), { recursive: true });
fs.copyFileSync(path.join(katexDist, 'katex.min.css'), path.join(out, 'katex', 'katex.min.css'));
fs.cpSync(path.join(katexDist, 'fonts'), path.join(out, 'katex', 'fonts'), { recursive: true });
console.log('renderer built ->', out);
