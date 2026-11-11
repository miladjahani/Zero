#!/usr/bin/env node
/**
 * NEXUS Worker Builder
 * Generates public/repo/nexus.js from modular parts
 * Run: node scripts/build-nexus.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');
const PARTS_DIR = join(ROOT, 'scripts', 'nexus-parts');
const OUT = join(ROOT, 'public', 'repo', 'nexus.js');

mkdirSync(dirname(OUT), { recursive: true });

const parts = [
  '01-header.js',
  '02-crypto.js',
  '03-kv.js',
  '04-datacenters.js',
  '45-ip-resolver.js',
  '50-smart-engine.js',
  '51-node-gen.js',
  '52-outputs.js',
  '53-geo.js',
  '54-response.js',
  '55-proxy.js',
  '56-router.js',
  '60-page-template.js',
  '99-footer.js',
];

let out = '';
for (const p of parts) {
  const fp = join(PARTS_DIR, p);
  try {
    const content = readFileSync(fp, 'utf8');
    // Build comment: only inside JS blocks (not in HTML template area)
    const isInsideTemplate = p.startsWith('60-') || p.startsWith('99-');
    if (!isInsideTemplate) {
      out += '\n/* ══════════════════════════════════════════════════════════════════════════\n';
      out += `   ▓ ${p}\n`;
      out += '   ══════════════════════════════════════════════════════════════════════════ */\n';
    }
    out += content;
    out += '\n';
    console.log(`  ✓ ${p} (${content.split('\n').length} lines)`);
  } catch (e) {
    console.error(`  ✗ ${p}: ${e.message}`);
    process.exit(1);
  }
}

writeFileSync(OUT, out, 'utf8');
const lines = out.split('\n').length;
console.log(`\n✅ Built nexus.js: ${lines} lines, ${out.length} bytes`);
