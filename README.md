# makefun-sitegen-speed-v5

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/muhammadaldy198/makefun-sitegen-speed-v5/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/muhammadaldy198/makefun-sitegen-speed-v5/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A fast drop-in replacement for makefun-site 1.0.0: it builds the same static site output tree, byte for byte, in a fraction of the CPU time. Pure JavaScript, dependency-free: a 15-byte `main.ts` proxy, a small CommonJS driver (`r.js`), and the engine (`solve.js`). This is a total rebuild (v5) of the v3 entry — new template engine and V8 flags throughout, not a patch on it.

## How it works

`run(input)` in `solve.js` reimplements the whole makefun-site build from scratch — front matter, Markdown, templates, collections, permalinks, the report — with the same semantics, tuned for speed:

- **CommonJS driver, not ESM.** `main.ts` is a 15-byte `require('./r')` proxy so the harness's module load is trivial and the real work starts in CommonJS, whose `require()` is cheaper than ESM import for a big module. V8 flags are set before `solve.js` loads: `--no-turbofan --no-incremental-marking` — every grader round is a fresh cold process in a 1-CPU container, and TurboFan's background compile jobs cost more CPU than Maglev's slower code loses (12-round interleaved A/B: -40 ms trimmed mean unpinned, -55 ms pinned to 1 CPU).
- **Templates are interpreted, not compiled.** The parsed node tree is the program: one render loop walks it and appends to a shared accumulator, with no `new Function` anywhere — so there is no per-template parse-and-compile cost in the cold process, and the interpreter still beats the compiled functions warm (warm `run()` 131 ms vs 147 ms). Path lookups are guarded walks; loop variables and the `loop` object are saved and restored around loops, including the `loop`-named loop variable quirk.
- **Static fragments are rendered once per case.** A template whose reads are only `site`, `tags` and `recent` (nav, header, footer) is rendered once and reused by every page, with guards that disable the cache when a case's templates could make it wrong (include cycles, deep nesting, a loop shadowing a static root).
- **Answers JSON goes straight into a preallocated Buffer.** `runJsonBuf` writes the 7 MB answers JSON into one 24 MB sink as the build runs — no giant string join, no second UTF-8 encode pass over the answer. The sink doubles if a piece ever does not fit.
- **Fused inline escaping.** One regex pass over each inline run handles structural characters and HTML-special characters together, emitting entities inline instead of escaping each plain run separately. HTML escaping itself tests for a special char first and only runs the replace when one is present — most template values are clean (micro-benchmark: -38% on esc).
- **Markdown is one index-based pass.** No `split('\n')`, no token objects: blocks are scanned by line ranges with first-character dispatch, inline markup jumps between structural characters with one fused regex, and fence bodies are escaped in a single call over the whole slice.
- **No per-page view objects.** The view fields (title, url, date, summary, excerpt, reading time, tags, content, neighbours) are attached to the source objects themselves — the source *is* the page and the card — and link resolution is cached per directory.
- **Front matter is scanned by index**, mirroring the reference's error strings and first-error order exactly.

Measured on the practice set (3 cases, Node 22.23.4 on this VM, cold end-to-end CPU of a fresh `node main.ts` process, 12 rounds interleaved against the null entry): v5 **587.2 ms** median / **585.0 ms** trimmed mean against the null entry's 138.3 ms, so **447.9 ms** net. Against v3's recorded numbers on the same machine and harness (median 638.2 ms, trimmed mean 639.2 ms, net 497.7 ms): **~8.5% faster unpinned, ~12% faster pinned to 1 CPU** (the grader's shape: v5 trimmed mean 542.4 ms vs v3 616.8 ms). Output is byte-identical on the practice cases, on 30 fresh generator draws and 9 adversarial input groups (39/39 identical to the oracle: backslash runs, unclosed fences and front matter, template include cycles, loop variables named `loop`, CRLF, unicode slugs), and two cold runs produce byte-identical output. `grade-local --driver process` passes 3/3 (L1 regrade reproduced byte for byte).

## Run it

```sh
MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=output node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=3p0axm2p&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
