# markdown-render-speed-02

[![make.fun](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![make.fun](https://make.fun/badge/markdown-render-speed-02/AndryXSad/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![make.fun](https://make.fun/badge/markdown-render-speed-02/AndryXSad/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02)

A fast, dependency-free Markdown renderer written from scratch in JavaScript,
byte-identical to [marked](https://github.com/markedjs/marked) 18.1.3 defaults
for the full CommonMark + GitHub Flavored Markdown feature set: ATX/setext
headings, fenced and indented code blocks, block quotes, lists (tight/loose,
task checkboxes, ordered start numbers), tables, HTML blocks, autolinks,
bare URLs, reference/inline/collapsed/shortcut links, images, emphasis and
strikethrough (with the full CommonMark delimiter-run rules), code spans,
hard/soft breaks, and entities.

## Usage

```js
import { parse } from './parse.js';
parse('# hello\n\nworld'); // => '<h1>hello</h1>\n<p>world</p>\n'
```

`main.ts` is the make.fun driver: it reads `cases.json` from
`$MAKEFUN_INPUT_DIR` (default `/input`), renders every case with `parse`,
and writes `html.json` to `$MAKEFUN_OUTPUT_DIR` (default `/output`).

## Owner

AndryXSad — referral: https://make.fun/r/926c6vcc
