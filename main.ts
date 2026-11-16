// Driver for the make.fun markdown-render-speed-02 bounty.
// Reads the case list from /input/cases.json (or $MAKEFUN_INPUT_DIR), renders
// each case's markdown with parse(), and writes /output/html.json in order.
// Only Node built-ins + ./parse.js are used. The input may be a bare JSON
// array of {id, markdown} objects or an object with a `cases` array; a case
// without a `markdown` string renders as empty output.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR || '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR || '/output';

const raw = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8'));
const cases = Array.isArray(raw) ? raw : raw.cases;

const html = [];
for (const c of cases) {
  html.push(parse(typeof c.markdown === 'string' ? c.markdown : ''));
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
