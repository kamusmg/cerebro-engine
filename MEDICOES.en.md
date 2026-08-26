<div align="center">

[Português](MEDICOES.md) • **English**

# 📊 The measurement record of cerebro-engine

### Every number this project has published, with the method, the ruler, and the retractions.

</div>

---

> ⬅️ **[Back to the README](README.en.md)** — what the project is, how it works, how to install.

> **Why this lives outside the README.** The README answers *"what is it and how do I use it"*.
> This document answers the other question, the longer and more important one for anyone about to
> trust a number: *"how was this measured, and what does the number not say"*. Nothing was shortened
> in the move — including the corrections where the project contradicted itself and had to walk
> something back. Those are the most expensive asset this repository owns.

## 📊 Measured — on TWO golden sets, one of them held out

| retriever | recall | hit@3 | MRR |
|---|:---:|:---:|:---:|
| graph BFS (baseline) | 15/24 | 14/24 | 0.529 |
| hybrid + rewrite + RRF | 20/24 | **19/24** | 0.653 |
| **+ BM25 with prefix matching** | **20/24** | 18/24 | **0.693** |

The 4 residual misses are **coverage** (Arduino/`.ino` symbols the parser doesn't extract), **not**
retrieval. On targets that exist in the graph: **20/20**.

> 🔴 **YOU CANNOT REPRODUCE THESE NUMBERS, and you deserve to know that before trusting them.**
> Until 2026-08-25 this line said *"reproduce with `node harness-recall.mjs`"* — and you could
> not: the golden set points at the author's **private** repositories, so shipping it would leak
> precisely what this repo is careful not to leak. The harness is here, the method is described,
> the numbers are reproducible **by the author** — and to you they are his word.
>
> What you can do is measure **yours**: build a set in the shape of
> [`golden-questions.example.json`](reports/golden-questions.example.json) over your own code
> and run the harness. That is the only measurement that answers the question you actually have.
>
> **A shortcut, correctly labelled:** `node generate-golden.mjs <project>` builds a set from the
> docstrings and symbols of the graph itself. It is **not blind** — the questions come out of the
> same `graph.json` the engine searches, and the target is by definition a node the graph already
> knows. What it measures is **coverage**, and it works as a regression guard: if it drops between
> versions, something broke. What it does **not** answer is *"does the engine find what I look
> for"* — for that, write the questions before looking at the graph.

### The three paths of the same engine (2026-08-25)

The table above measures **one** path. The engine is used through three different doors, and
until 2026-08-25 only the middle one had a number — which was quoted as if it described the
first. All three are now measured side by side, in the same run:

| path | recall | hit@3 | MRR |
|---|:---:|:---:|:---:|
| `--termos` supplied by the caller | 20/24 | 17/24 | **0.701** |
| rewrite-cache hit | **21/24** | 17/24 | 0.636 |
| `--sem-rewrite` (no term arm) | 17/24 | 14/24 | 0.533 |

Two readings. **The term arm pays for itself**: 3 to 4 more answers found than the baseline, and
+0.10 to +0.17 MRR. And the production path **trades one hit for a clearly better rank** — which
makes sense, because whoever asks knows the conversation and picks better identifiers than a
cache frozen weeks ago.

> ⚠️ **Measuring the first two paths together requires `CEREBRO_CACHE_RO=1`** (the harness sets
> it). Without it, measuring the `--termos` path **writes the measurement's own terms into the
> rewrite cache**, and the cache path then returns those same terms: both arms collapse into one
> number and the older arm's baseline dies inside the measurement itself. This was caught
> happening — the cache arm dropped from 21/24 · MRR 0.636 to exactly the other arm's figure,
> which **reads like a finding and is an artifact**. The thermometer must not change the
> temperature.


> ⚠️ **Don't read this table without the composition of the golden set.** Most of these questions
> fall in the regime where plain text search would already work, which inflates any aggregate number.
> See [what these numbers do **not** prove](#-what-these-numbers-do-not-prove) before comparing
> against your own.

### The training set isn't enough — and here's the proof

The 24 questions above are **training**: they and the tuning they justify were born together. So there
is a second set, **built backwards on purpose** — the target is sampled mechanically (fixed seed)
among documented nodes, and only **then** is the question written from what that code does. It has
never been used to tune anything.

**It rejected the first version of this very improvement.** Textbook BM25 with exact-token matching
looked great on training (recall 20→**21**, MRR 0.653→**0.733** with a tuned `k1`) and collapsed on
the held-out set (recall **11/14** vs 12/14 for the older code), with the tuned `k1` scoring
*identically* to the default — the tuning bought nothing.

The cause: the substring matching that the "fix" removed was working as an **accidental cross-lingual
stemmer**. When questions are written in one language and identifiers are English, the question's word
is often a **prefix** of its English cognate (`portugues` ⊂ `portuguese`). Hence the final design:
BM25 with literature-default `k1`/`b`, and **prefix** matching.

| | training (24) | held-out (14) | nodes/question |
|---|---|---|---|
| substring (previous) | MRR 0.653 | recall 12 · MRR 0.721 | 36.4 |
| BM25 exact token | MRR 0.691 | recall **11** · MRR 0.693 | 34.6 |
| **prefix + BM25 (default)** | MRR **0.693** | recall 12 · MRR **0.764** | **34.6** |

A/B at any time: `CEREBRO_LEXICO=legado|bm25|prefixo`.

### 🔴 Correction: the held-out column above was measured on a crippled engine

The cross-language rewrite bridge is one call to a free-tier API. The quota had run out; the engine
degraded to the lexical arm alone and **said so** (`rewrite=falhou`) — but the harness never read
the warning and published the number as a property of the engine. Reproduced exactly afterwards, by
hiding the cache and the key: `recall 12/14 · MRR 0.764 · 34.6 nodes`, digit for digit.

With the bridge alive, same golden set:

| lexical arm | held-out (bridge ALIVE) | nodes/question |
|---|---|---|
| substring (legacy) | recall **14/14** · hit@3 12/14 · MRR **0.885** | 39.1 |
| **prefix + BM25 (default)** | recall **14/14** · hit@3 **13/14** · MRR 0.867 | 41.4 |

Two consequences. The good one: **the engine is better than what was published.** The bad one:
**the default lexical arm was chosen on a crippled engine.** Crippled, `prefix` won comfortably;
intact, the two are **tied** — `legado` leads on MRR, `prefix` on hit@3 at ~6% more nodes. `prefix`
stays the default on the strength of the training set (0.693 vs 0.653), but by a narrow margin.

> **The lesson, good for any harness:** an optional component that fails on its own turns every
> subsequent measurement into a measurement of a different engine. If your retriever has a part
> that can degrade, **the harness must refuse to print a number** when it does. Here that guard
> existed — in *another* file, added the day before. A defense applied in one place is a defense
> that doesn't exist yet.

> **If you benchmark your own retriever, steal this and not the number:** a golden set you tuned
> against no longer measures the engine, it measures the set. Build the second one backwards (target
> first, by sampling; question afterwards) and run it **once per change**.

## ⚖️ What these numbers do **not** prove

An aggregate number hides **what kind** of questions were asked. Following
[CodeCompass](https://arxiv.org/abs/2602.20048), which evaluates code retrieval across three regimes,
every question is classified **mechanically** — the graph decides, not the author:

| | the target is… | what would already find it |
|---|---|---|
| **G1** | named by a term in the question itself | `grep` |
| **G2** | ≤2 hops from something the question names | traversal — **this is where a graph should pay off** |
| **G3** | neither named nor reachable by short traversal | only a semantic index |

And the result is uncomfortable:

| | composition | G1 | G2 | G3 |
|---|---|---|---|---|
| training (24) | 71% G1 | 16/17 · MRR **0.843** | 2/2 · hit@3 **0/2** | 2/5 |
| held-out (14) | **86% G1** | 12/12 · MRR **0.892** | n=1 | n=1 |

**In other words: `MRR 0.764` is effectively the G1 number** — the regime where keyword search would
already work. The engine is very good there. In the regime that would justify a graph existing, it is
**unproven**, for two different reasons:

- **G2 is a RANKING defect, not a retrieval one.** Recall 2/2, hit@3 **0/2**: the engine **finds the
  target and buries it**. The cause is known — graph distance only takes 3 values, so dozens of nodes
  tie and the tie-break ends up being BFS insertion order. *(We tried breaking ties by convergence,
  summing `1/(1+d)` across seeds: it regressed both sets and cost +51% tokens, most likely because it
  rewards hub nodes — exactly what the `sqrt(refs)` damping exists to prevent. If that's your first
  idea, it was ours too, and it didn't work.)*

  **Update 2026-07-29 — a second cause, and this one was bigger.** The recency weight was **×50** in
  the file-selection step: any file touched in git within 30 days outranked any untouched file,
  regardless of relevance. Caught on a real question where the seeds hit the exact target symbol
  (**rank 1 with the boost off**) and eight recently-edited files pushed past it — the target did not
  even make the top 8. So part of "finds it and buries it" was this spice, not the BFS tie. Lowered to
  **×3**, chosen on the blind set (held-out 14/14, training 20/24; `×1` won on training and **lost**
  on held-out).
  **What we have NOT measured: whether this fixes G2's hit@3.** It is plausible and unverified — the
  G2 stratum has not been re-run since the change. It stays a hypothesis, not a fix.
  The origin error matters more than the number: the 2026-07-18 measurement compared
  *boost-on-node vs boost-on-file* and picked the latter. **Nobody compared boost vs NO boost.**
  Every heuristic has to beat the "without it" baseline.
- **G3 remains UNTESTED — neither confirmed nor refuted.** A third set scored **1/3**, and for five
  days this text called that *"a result that runs against the project's bet"*, adding G2's `0/1` to
  claim "three independent sets tell the same story". **That was self-contradictory:** the section
  just below explains that **8 of the 12 questions in that set were not G3 at all** — so it is not an
  independent third set, and `1/3` over a disqualified sample is evidence of nothing. Corrected
  2026-07-29. What is left is honest and smaller: **nobody has measured G3 yet.** That line of work
  is shelved for **cost**, not because it was refuted.

### And the "G3" set wasn't G3 — a warning for anyone repeating this

Those 12 questions were mined from the graph by looking for pairs (A→T) joined by an edge and
sharing **no tokens at all**, expecting that to yield hidden dependencies. The classifier disagreed:
**8 of the 12 are G1.** The mining hit its target 3 times out of 12.

The failure is instructive: A and T not sharing vocabulary **does not imply** that the *question*
doesn't share vocabulary with T. The question is written by a human describing the consumer, and it
smuggles the target's vocabulary back in by another route. **If you build a G3 set, classify the
final question — not the node pair.** Otherwise you measure G1 while believing you measure G3.

> **The honest reading:** what's demonstrated here is **token economy** — the same answer from a
> fraction of the context, and that held up in every measurement (6.2x, 20/24 hit rate). **Superiority
> over `grep` is undemonstrated** — and note that "undemonstrated" is not "refuted", which is what
> this paragraph asserted until 2026-07-29 ("the little evidence that exists points against it").
> Only G2 has a measured, real defect; the G3 set was invalid. The samples are small and settle
> nothing on their own, but they are the only ones there are, and hiding them behind a pretty
> aggregate would be dishonest — as would hardening them into a verdict, which is the opposite error
> and is the one that happened here.
>
> If you publish numbers for your retriever, publish the **composition** alongside them: without it,
> "MRR 0.76" can mean very different things.
