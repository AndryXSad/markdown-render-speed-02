# markdown-render-speed-02

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/AndryXSad/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/AndryXSad/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A dependency-free, fast Markdown renderer in a single `parse.js` (ES module, no imports). It produces HTML byte-identical to marked 18.1.3 with default options (GFM on, breaks off) on the CommonMark 0.31.2 + GFM 0.29 spec examples, including the places where marked deviates from the spec. `main.ts` is the driver: it reads `/input/cases.json` (or `$MAKEFUN_INPUT_DIR`), renders every case with `parse()`, and writes `/output/html.json` in order.

## How it works

`parse.js` is a single-file, dependency-free parser in three layers:

- **Block parser** — a frame stack (document / blockquote / list / list item) with a two-phase line loop: container matching (with lazy-line and fence-in-list rules), then leaf handling (paragraph, fenced/indented code, HTML block, ATX/setext heading, hr, table, link reference definitions).
- **Inline parser** — one left-to-right scan into a flat node list (text, code span, delimiter, link open/close, image, HTML, breaks), followed by delimiter-stack emphasis resolution with the CommonMark flanking rules plus marked's link-text label rule.
- **Renderer** — a single depth-first walk that emits the HTML byte-for-byte.

It is deterministic (two runs produce byte-identical output) and uses only Node built-ins.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=926c6vcc&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
