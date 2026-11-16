// Driver for the markdown-render-speed-02 entry.
// Reads every case from /input/cases.json, renders each one with the
// dependency-free parser in parse.js, and writes the HTML strings to
// /output/html.json in the same order as the input cases.
// Outside a container, MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in
// for /input and /output. Run with: node /bot/main.ts

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

function loadCases(dir) {
  const raw = readFileSync(join(dir, 'cases.json'), 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('cases.json must hold an array');
  return parsed;
}

function renderAll(cases) {
  const out = new Array(cases.length);
  for (let idx = 0; idx < cases.length; idx++) {
    const item = cases[idx];
    const source = typeof item === 'string' ? item : item.markdown;
    out[idx] = parse(source);
  }
  return out;
}

function main() {
  const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  const cases = loadCases(inputDir);
  const html = renderAll(cases);
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
}

main();
