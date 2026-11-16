# markdown-render-speed-02

[![make.fun](https://img.shields.io/badge/make.fun-bounty-7c3aed)](https://make.fun/bounty/markdown-render-speed-02)
[![markdown-render-speed-02](https://img.shields.io/badge/markdown--render--speed--02-%24250-22c55e)](https://make.fun/bounty/markdown-render-speed-02)
[![referral](https://img.shields.io/badge/referral-926c6vcc-f59e0b)](https://make.fun/r/926c6vcc)

A dependency-free CommonMark renderer in a single ES module (`parse.js`,
zero imports), built for the
[make.fun markdown-render-speed-02 bounty](https://make.fun/bounty/markdown-render-speed-02).
It renders Markdown to HTML byte-for-byte identical to the reference on the
practice set, covering ATX and setext headings, emphasis, links, autolinks,
tables, fenced and indented code, block quotes, nested bullet/ordered/task
lists, raw HTML blocks, entities and hard line breaks.

## Usage

`main.ts` is the entrypoint. It reads `$MAKEFUN_INPUT_DIR/cases.json`
(default `/input`) and writes `$MAKEFUN_OUTPUT_DIR/html.json` (default
`/output`) as a JSON array of HTML strings, one per case, in input order.

```sh
node main.ts
```

## Files

- `parse.js` — the renderer: `export parse(markdown)`.
- `main.ts` — driver (Node built-ins + `./parse.js` only).
- `LICENSE` — MIT.

Owner: AndryXSad. Referral: `926c6vcc` — https://make.fun/r/926c6vcc
