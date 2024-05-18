# Evaluation Dataset Sampler

An offline, dependency-free reporter that selects saved evaluation cases by a reproducible seed, explicit risk/category/failure-history/coverage quotas, and a validated holdout boundary. It returns only opaque case and source identifiers; it does not run evaluations or modify a dataset.

## Quick start

Node 22+ is required. There is no install step, package dependency, network call, or external account.

```sh
node bin/eval-dataset-sampler.mjs --root examples --dataset clean.dataset.json --plan plan.json
node bin/eval-dataset-sampler.mjs --root examples --dataset leak.dataset.json --plan plan.json
npm run check
```

The clean example exits 0 with `status: pass` and two selected IDs. The leak example exits 1 with `status: fail` and an empty sample. CLI stdout contains one JSON report for completed or incomplete dataset checks. Import `sampleDataset`, `TOOL_ID`, `RULE_SEVERITY`, or `exitCodeFor` from `src/index.mjs`; file-based callers can import `checkSample` from `src/check.mjs`. Both accept an injected `now` clock function, defaulting to `Date.now`.

## Dataset and plan

The dataset is a UTF-8 JSON object with `schemaVersion: 1`, a nonempty `candidates` array, and a `holdout` array (which may be empty). Each candidate has exactly `id`, `sourceId`, `contentSha256`, `risk`, `category`, `priorFailures`, and `coverageTag`. A holdout entry has exactly `id`, `sourceId`, and `contentSha256`. IDs/source IDs are 1–128-character opaque ASCII tokens beginning with an alphanumeric character and then containing only letters, digits, `.`, `_`, `:`, or `-`. Do not put names or other personal data in these identifiers: selected IDs and source IDs are deliberately reported. `contentSha256` is a lowercase 64-hex digest claim supplied by the exporter, not calculated from private content. Duplicate candidate ID or digest and duplicate holdout ID or digest make the evidence incomplete; candidate source IDs may repeat.

`risk` is `high`, `medium`, or `low`. `category` and the **single** `coverageTag` are 1–64-character ASCII labels beginning with a letter or digit and otherwise using letters, digits, `_`, or `-`. `priorFailures` is a nonnegative safe integer. It maps to `none` at 0, `some` at 1–2, and `repeat` at 3 or more. One tag per candidate keeps coverage targets disjoint and makes quota feasibility exact, rather than heuristic. An unknown or malformed record is never treated as absent or compatible.

Numeric JSON tokens must have the same exact decimal value as their parsed number's shortest round-trip decimal rendering. Legal spellings such as `1.0` and `3e-1` remain usable; a token rounded into an integer or underflowed to zero is refused before it can alter failure bands, sample sizes or quotas. This is a conservative evidence rule, not a claim of binary-exact arithmetic.

The plan is a separate JSON object with `schemaVersion: 1`, an opaque `seed`, `sampleSize` of 1–1,000, and `targets`. Every observed four-axis stratum `(risk, category, priorFailureBand, coverageTag)` needs exactly one target with those four fields and a minimum `min`. A target with no observed stratum, or an observed stratum with no target, is incomplete. High-risk observed strata require `min >= 1`; other minima may be zero. Duplicate targets or minima summing above `sampleSize` are invalid configuration. A minimum beyond available candidates, or a sample larger than all candidates, is a known shortage and fails without a partial sample.

## Selection and holdout order

The complete holdout is validated before non-collision, quota, or selection claims. A candidate colliding with **any** held-out ID, source ID, or content digest fails with no sample, even if its other fields differ. Unknown strata and incomplete evidence outrank independently known collisions or shortages; they remain `incomplete`, never pass.

Within each stratum, candidates rank by SHA-256 of the JSON tuple `[seed,id,sourceId,contentSha256]`, with code-unit ID as tie-breaker. The sampler first takes every target minimum, then fills remaining slots globally by rank. Because strata do not overlap, a feasible plan always keeps its configured rare high-risk coverage. The final `sample` contains `{id,sourceId}` pairs sorted by UTF-16 code unit on ID. The same files and seed produce byte-identical stdout, independent of filesystem order. The seed is a ranking input, not a credential or secret.

## Rules, status, and exits

| Rule IDs | Severity | Meaning |
| --- | --- | --- |
| `invalid-dataset`, `no-candidates`, `invalid-candidate`, `duplicate-candidate`, `invalid-holdout`, `duplicate-holdout` | error | Required or unambiguous dataset evidence is missing. |
| `candidate-limit`, `holdout-limit`, `input-limit`, `unreadable-dataset`, `parse-error`, `invalid-evidence`, `timeout` | error | Dataset could not be fully evaluated. |
| `unknown-stratum` | error | Dataset and plan strata do not match exactly. |
| `holdout-id-collision`, `holdout-source-collision`, `holdout-digest-collision` | error | A candidate crosses the holdout boundary. |
| `sample-shortage`, `quota-shortage` | error | Complete evidence proves the requested coverage is unavailable. |

The report uses `schemaVersion: "1"`, `tool`, `status`, `summary`, deterministic `findings`, and `sample`. `pass` has no findings and the full sample; `fail` and `incomplete` always have an empty sample. Findings include fixed messages and ordinal locations, never raw holdout IDs, source IDs, hashes, or labels. Findings sort by file, pointer, then rule using UTF-16 code-unit order.

| Exit | Meaning | stdout |
| ---: | --- | --- |
| 0 | Complete sample, all targets met | JSON report, `status: pass`. |
| 1 | Proven holdout leak or shortage | JSON report, `status: fail`. |
| 2 | Invalid CLI or plan configuration | Empty; fixed stderr diagnostic. |
| 2 | Unreadable, malformed, incomplete or over-limit dataset | JSON report, `status: incomplete`. |

## Limits and local read boundary

Default limits: 1,048,576 bytes **per file**, 10,000 candidates, 10,000 holdout entries, 100,000 JSON nodes, nesting depth 16, 1,000 plan targets, 1,000 selected records, and a cooperative 30,000 ms timeout. CLI overrides are `--max-bytes`, `--max-candidates`, `--max-holdout`, `--max-nodes`, `--max-depth`, and `--timeout-ms`; corresponding programmatic `limits` keys have the same names. Unknown limit keys are rejected. Exact N is admitted and N+1 refused: an exceeded dataset bound is incomplete, and an exceeded plan bound is invalid configuration.

Duplicate JSON object keys are rejected before parsing can erase an earlier value. Text is decoded as strict UTF-8. Both file paths are resolved under the real declared root; an in-root symlink is accepted and one escaping the root is refused. The tool reads only local files, writes no file, and never connects to a database, model, browser or network.

## Non-goals

The sampler does not judge case quality, calculate content digests, infer missing failure history, create evaluation data, run a model, guarantee statistical representativeness, or decide that a caller was authorized to expose selected opaque IDs. It enforces only the explicit evidence, quotas and holdout boundary described here.
