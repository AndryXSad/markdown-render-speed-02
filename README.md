# markdown-render-speed-02

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/AndryXSad/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/AndryXSad/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A fast, dependency-free Markdown renderer in a single file (`parse.js`, an ES module with zero imports). It renders HTML byte-identical to marked 18.1.3 with default options (GFM on, breaks off) — including the corners where marked deviates from CommonMark and GFM, such as tab expansion inside nested blockquotes and link labels with unpaired backticks. The block layer uses a container frame stack with a two-phase line loop (container matching, then leaf handling); the inline layer scans once into a flat node list and resolves emphasis with the CommonMark flanking rules plus marked's link-label rules. `main.ts` drives it: it reads the cases and writes the HTML array, deterministically.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=926c6vcc&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
