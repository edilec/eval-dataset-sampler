# Evaluation dataset sampler design

## Outcome

Read one saved local dataset and one local sampling plan. Return reproducible selected opaque IDs and source IDs without modifying either file. A complete, legal plan yields `pass`/exit 0; proven holdout leakage or quota shortage yields `fail`/exit 1 with no partial sample; missing or ambiguous evidence yields `incomplete`/exit 2 with no partial sample. Invalid CLI or plan configuration yields exit 2 and empty stdout. There is no network or external evaluation call.

## Evidence and plan

Dataset schema version 1: `candidates` and `holdout` arrays. Candidate records contain `id`, `sourceId`, lowercase 64-hex `contentSha256`, `risk` (`high`, `medium`, `low`), `category`, `priorFailures` (nonnegative safe integer), and one `coverageTag`. Holdout entries contain `id`, `sourceId`, and `contentSha256`. Identifiers are opaque ASCII tokens; category and coverage tag are ASCII labels. Duplicate candidate ID or digest, malformed records, duplicate holdout identity, or absent metadata makes the run incomplete. Holdout collisions on **any** candidate ID, source ID, or content digest are known leakage and fail. Validate the complete holdout before any positive non-collision claim or quota check.

Plan schema version 1: `seed`, `sampleSize`, and an explicit `targets` array. Each target names a disjoint four-axis stratum `(risk, category, priorFailureBand, coverageTag)` and an integer minimum `min`. Bands are `none` for zero, `some` for 1–2, `repeat` for 3+. Exactly one target is required for every observed stratum. A target without a corresponding observed stratum or an observed stratum without a target makes the run incomplete. For an observed high-risk stratum, minimum must be at least one. Targets beyond available records and sample sizes beyond candidates are proven shortages; a sum of target minima above sample size is invalid plan configuration.

## Deterministic selection

Compute SHA-256 of the JSON tuple `[seed,id,sourceId,contentSha256]` for each candidate. Sort by digest and then ID using UTF-16 code-unit order. Select each target's first `min` candidates, then fill any remaining slots from the lowest-ranked unused candidates globally. Return selected `{id,sourceId}` pairs sorted by ID using code-unit order. This guarantees all disjoint quotas exactly when the plan is feasible; no heuristic can falsely claim shortage. The seed is an input to ranking, not a credential or randomness source. Same inputs and seed yield byte-identical stdout.

## Safety and bounds

All JSON is strictly UTF-8 decoded with duplicate-key rejection before parsed evidence can be used. Both file paths resolve under the real declared root. Default bounds: 1,048,576 bytes per file; 10,000 candidates; 10,000 holdout records; 100,000 JSON nodes; depth 16; 1,000 targets; 1,000 selected records; cooperative timeout 30,000 ms. Each N/N+1 boundary has a positive and negative test. A bounded fixed severity map supplies all findings. The library injects the clock. Reports never include holdout identifiers, content hashes, or raw category/tag text in findings; selected records include the caller's opaque ID and source ID only.

## Verification priorities

Start with a correct exact-quota case. Pin same-seed stability, rare high-risk retention while other strata compete, each holdout collision axis, unknown stratum and malformed holdout precedence, shortage N/N+1, strict exit-2 shapes, all bounds, read confinement, code-unit order, and counterfactual tests for every README guarantee.
