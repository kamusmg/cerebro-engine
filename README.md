# cerebro-engine

**Make your AI coding agent ask a code graph "where does X live?" instead of blindly reading 30 files.**

A small, local, free retrieval layer over [graphify](https://github.com/safishamsi/graphify): it turns a
natural-language question into the handful of files/symbols that answer it. Fewer tokens, faster answers —
and it ships a **benchmark so you measure the savings on your own code**, not on a marketing number.

> Honest positioning: this does **not** promise "8x savings." It hands you the method and the harness so
> you measure it on your repos. If the number looks too good, the method is wrong.

## Why
An agent that opens 30 files to answer one question burns tokens and time. A code graph (tree-sitter
symbols + Leiden communities, via graphify) turns *"where's the subtitle-punctuation logic?"* into a
pointer to the two files that matter. The graph is an **index**; the file is the **truth** — always
confirm in the real code before editing.

## What's inside
- **`ask.mjs`** — question → the files/symbols that answer it. Hybrid retrieval: lexical + a
  **query-rewrite bridge** (ask in one language, code in another? it crosses that) + graph traversal,
  fused with **Reciprocal Rank Fusion** (k=60). Built on graphify; nothing reinvented.
- **`retrieval.mjs`** — the engine: own seed selection over `graph.json` with aider-style hardening
  (`sqrt(refs)` damping so frequent symbols don't dominate, `×0.1` generic, `×10` well-named), own BFS,
  RRF. Zero external services beyond an optional Gemini free-tier key for the cross-language rewrite.
- **`harness-recall.mjs`** — measures **recall / hit@3 / MRR** on a golden set *you* build from your repos.

## Measured (author's 24-question golden set, ground truth verified by grep)
| retriever | recall | hit@3 | MRR |
|---|---|---|---|
| graph BFS (baseline) | 15/24 | 14/24 | 0.529 |
| **this (hybrid + rewrite + RRF)** | **20/24** | **19/24** | **0.653** |

The 4 residual misses were **coverage** (Arduino/`.ino` symbols the parser doesn't extract), not
retrieval. On targets that exist in the graph: **20/20**. Reproduce with `node harness-recall.mjs`.

## Install
Prereqs: **Node 22+**, **[graphify](https://github.com/safishamsi/graphify)**
(`uv tool install "graphifyy[gemini]"`), and optionally a **`GEMINI_API_KEY`** (free tier) for the
cross-language query rewrite.

```bash
git clone https://github.com/kamusmg/cerebro-engine
cd cerebro-engine
cp projects.example.json projects.json      # list YOUR repos: { name, root }

# build a graph for each repo (graphify does the indexing)
graphify update "/absolute/path/to/my-backend"

# ask
node ask.mjs "where is the auth token validated" my-backend
node ask.mjs --lista                          # projects that have a graph

# measure recall on your own golden set
cp reports/golden-questions.example.json reports/golden-questions.json   # edit with YOUR questions
node harness-recall.mjs
```

Flags: `--motor=graphify` (A/B against the raw graphify query), `--sem-rewrite` (disable the
cross-language bridge), `--cru` (raw, no re-rank).

## Prior art (nothing created, everything copied)
Repo-map ranking from [aider](https://aider.chat/2023/10/22/repomap.html) (the `sqrt(refs)` damping is
what stops frequent symbols dominating). The cross-language bridge is
[HyDE](https://arxiv.org/abs/2212.10496)-adjacent query rewriting. Fusion is
[RRF](https://dl.acm.org/doi/10.1145/1571941.1572114) (k=60). Embeddings are deliberately **not** used:
the rewrite bridge already gets full recall on extractable targets, and (à la
[Cody](https://sourcegraph.com/blog/how-cody-understands-your-codebase)) they weren't worth the
index-maintenance cost. They're pre-wired as a 4th RRF arm if a bigger benchmark ever needs them.

## Principles
- **The graph is the index; the file is the truth.** It points; you confirm in code.
- **If the number looks too good, the method is wrong.** Numbers here are measured, method stated.
- **Measure before you build.** The embedding arm wasn't built because the data didn't ask for it.

## License
[MIT](LICENSE).
