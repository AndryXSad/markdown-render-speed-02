// Driver for the make.fun markdown-render-speed-02 bounty.
//
// Reads every case from $MAKEFUN_INPUT_DIR/cases.json (default /input),
// renders each case's markdown with parse() from ./parse.js, and writes
// the resulting HTML strings, in input order, to
// $MAKEFUN_OUTPUT_DIR/html.json (default /output) as a JSON array.
// The input file holds either a bare array of { id, markdown } objects
// or an object with a `cases` array; a case without a markdown string
// renders as an empty string. Only Node built-ins are used besides
// ./parse.js, and the output is deterministic.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const parsed = JSON.parse(readFileSync(join(inDir, 'cases.json'), 'utf8'));
const list = Array.isArray(parsed) ? parsed : parsed.cases;

const out = list.map((entry) =>
  parse(typeof entry.markdown === 'string' ? entry.markdown : ''),
);

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'html.json'), JSON.stringify(out));
