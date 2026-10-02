import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
fs.mkdirSync(path.join(root, 'release'), { recursive: true });
const out = path.join(root, 'release', `study-helper-${pkg.version}.mcpb`);
const bin = path.join(root, 'node_modules', '@anthropic-ai', 'mcpb', 'dist', 'cli', 'cli.js');
execFileSync(process.execPath, [bin, 'validate', path.join(root, 'mcpb', 'manifest.json')], { stdio: 'inherit' });
execFileSync(process.execPath, [bin, 'pack', path.join(root, 'mcpb'), out], { stdio: 'inherit' });
console.log('packed ->', out);
