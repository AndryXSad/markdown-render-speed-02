import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR || '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR || '/output';

const raw = readFileSync(inputDir + '/cases.json', 'utf8');
const data = JSON.parse(raw);
const cases = Array.isArray(data) ? data : data.cases;

const out = cases.map((c) => {
  const md = typeof c === 'string' ? c : (c.markdown ?? c.input ?? '');
  return parse(md);
});

mkdirSync(outputDir, { recursive: true });
writeFileSync(outputDir + '/html.json', JSON.stringify(out));
