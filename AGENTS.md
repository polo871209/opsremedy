# AGENTS.md

SRE investigation agent. Bun + TypeScript monorepo. Two-phase LLM agent (gather → diagnose) over GCP Logging, Prometheus, Jaeger, Kubernetes.

## Dev commands

```
bun test                          # bun:test, 5/5 in packages/core
bun run check                     # biome lint+format (must be clean before commit)
bunx biome check --write .        # apply safe fixes (incl. import order)
```

**No root tsc.** Typecheck per package:
```
for p in core clients tools bench cli notify; do bunx tsc --noEmit -p packages/$p/tsconfig.json; done
```

Run CLI without `bun link`:
```
bun packages/cli/src/main.ts <command>
```

`bench` uses fixture clients but still hits the real LLM — needs working OAuth/key.

## Architecture

Six workspaces:

- **core** — `runInvestigation()` → `executePipeline()` (shared by bench) → `gatherEvidence()` (pi-mono `Agent` w/ 11 tools, parallel exec, hard tool-call budget enforced via `reserveToolCallSlot` inflight counter) → `diagnose()` (no tools, strict JSON, 1 retry) → `validateAndFinalize()` (code-level claim check, recomputes confidence). Pi-mono = `@mariozechner/pi-agent-core` 0.70.2.
- **clients** — `Real*` + `Fixture*` impls per source. Module-level registry (`getClients`/`setClients`/`resetClients`). CLI wires real; bench swaps fixtures per scenario.
- **tools** — 11 `AgentTool` factories. Use `defineTool` helper or TypeBox params collapse to `unknown`. Each mutates `ctx.evidence.<key>` + records audit + returns short summary; full payload only seen by diagnoser.
- **cli** — onboard wizard + investigate + GCP URL fetch.
- **bench** — scenario runner + scoring (category, keywords, forbidden, evidence, trajectory, loops).
- **notify** — Lark message-card builder + `@larksuiteoapi/node-sdk` send wrapper. Pure `buildRcaCard` (testable) + thin `sendLarkCard` seam over `client.im.message.create`. CLI calls post-investigation; failures never fail the run.

Subpath exports `@opsremedy/core/types` and `@opsremedy/clients/{gcp,prom,jaeger,k8s,fixtures}` are load-bearing; tools rely on them.

## Config

Onboard wizard writes:
- `$XDG_CONFIG_HOME/opsremedy/config.yml` — non-secret URLs/model/project/k8s context.
- `$XDG_DATA_HOME/opsremedy/credentials.yml` (chmod 0600) — `llm_keys` + `llm_oauth`.

Resolution: **env > files > defaults**. `bootstrapRealClients()` is async (refreshes OAuth before run).

## Gotchas

- **Pi-ai needs `registerBuiltInApiProviders()`** before `getModels`/`findEnvKeys`. Already called in `bootstrap.ts` and `runOnboard()`.
- **`findEnvKeys(provider)` only reports already-set vars** — useless for injecting a key that the user only stored in `credentials.yml`. Always use `discoverProviderEnvVar` from `discover.ts`; that's what `bootstrap.ts:bootstrapAuth` does now.
- **OAuth lives at `@mariozechner/pi-ai/oauth`** subpath (not main barrel). Token push to env is manual: `bootstrap.ts:oauthEnvVarFor` — only anthropic + github-copilot use process env.
- **GCP Monitoring REST returns camelCase** (`openTime`, `closeTime`) despite docs. `gcp-alert.ts` accepts both — keep that.
- **K8s client v1.x uses ObjectParam style** (`@kubernetes/client-node` 1.4.0): `{namespace, fieldSelector}`, not positional. Old web examples are wrong.
- **`exactOptionalPropertyTypes: false`** but code is written as if true — use `...(x !== undefined && { key: x })` spreads. Match surroundings.
- **`bun link @opsremedy/cli` from repo root loops** — workspace already declares it. Run `bun link` (no args) inside `packages/cli`. Bin → `~/.bun/bin/opsremedy` (must be on PATH).
- **Diagnoser fallback on JSON parse fail** returns stub w/ `category: "unknown"`, `confidence: 0`. Not a runtime error.
- **`render-evidence.ts` caps logs/metrics/traces** before diagnoser prompt. Increasing caps inflates token cost.
- **`RealK8sClient.setCurrentContext` only fires when `opts.context` defined** — let kubeconfig's current-context win otherwise.
- **GCP logs `getEntries`**: never set both `pageSize` and `maxResults` (gax `AutopaginateTrueWarning`). Use `maxResults` only.
- **GCP `getEntries` ignores AbortSignal** — `q.signal` is `void`d; investigation can't be cancelled mid-log-fetch.
- **`ZERO_USAGE` + `UsageSummary` live in `core/src/types.ts`** — `util/usage.ts` re-exports them as `UsageTotal` for back-compat with pi-mono message rollups. Don't redefine.
- **Bench reuses `executePipeline` from core** — runner doesn't reimplement gather→diagnose→validate. Bench keeps its own `ctx` reference for scoring (`evidence`, `tools_called`).
- **Bench calls `resetClients()` before `setClients()` per scenario** — registry merges via `Object.assign`, so omitting a fixture would leak the previous scenario's clients.
- **Tool-call budget is parallel-safe via inflight counter** — `gather.ts:reserveToolCallSlot` bumps `ctx.inflight` before each call; `tools/define.ts` decrements in `finally`. A parallel batch can't exceed `max_tool_calls` even on the last slot.
- **Lark `Domain` enum**: `Domain.Lark` → `open.larksuite.com` (intl), `Domain.Feishu` → `open.feishu.cn`. Wrong choice → 401 from token endpoint. CLI exposes as `"lark" | "feishu"`.
- **Lark card `content` is double-encoded**: `client.im.message.create` takes `content: string`, and that string must itself be `JSON.stringify(cardJson)`. `send.ts` does this; don't pass the object.
- **Lark card body cap is 30KB** (`text` is 150KB). `card.ts` builds to a 25KB target with progressive truncation across 5 levels; oversize fallback replaces body with a stub markdown block.
- **Lark `uuid` field max 50 chars**, 1-hour dedup window. `buildSendUuid` uses 15-min buckets so quick re-runs collapse but distinct hours don't.
- **Lark bot must be in the chat first** — error 230002. Adding the bot is a manual step in the Lark group settings; can't be done via API for custom-bot security reasons.
- **Lark send failures never fail the investigation** — `cmdInvestigate` swallows errors after logging `[lark] error: …`. Don't change this; the report has already been emitted to stdout/markdown.
- **`@opsremedy/notify` depends on `@opsremedy/core/types`** subpath, not the main barrel — keeps the notify package free of pi-mono / agent runtime imports.

## Style

Biome: 110-col, double quotes, trailing commas, semicolons. `noNonNullAssertion: off`, `noExplicitAny: warn`. Imports auto-sorted by `bunx biome check --write .`. Comments short, WHY not WHAT, no banners.

## Bench

`packages/bench/scenarios/<NNN-name>/`:
- `alert.json` — input
- `gcp_logs.json`, `prom.json`, `jaeger.json`, `k8s.json` — fixture payloads
- `answer.yml` — expected category, keywords, forbidden, evidence sources, trajectory, max tool calls

Add scenario by copying an existing dir. Scoring in `packages/bench/src/scoring.ts`.

## Operational

- `investigate` is **read-only**. `propose_remediation` records suggestions, never executes. Don't add executing tools without explicit user approval.
- Agent runs against the configured `k8s.context` — **may be production**. Be careful adding new k8s tool calls.
- `--trace <path>` writes JSONL of all events; useful for post-hoc debugging.
