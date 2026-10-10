# AGENTS.md

Bun + TypeScript. opsremedy is a Lark bot that investigates GCP Monitoring alerts. Keep changes small, readable, and boring.

## Rules

- The agent is read-only. It may run against production clusters, so do not add a tool that writes to a cluster or a cloud unless the user asks for it. The only cluster write is `utils/token-refresh.ts`, which patches the bot's own token Secret.
- `config.yaml`, `seed-calls.yaml` and `.env.example` hold placeholders only. Never commit a real project id, URL, host, chat id, open id, or credential. `prek.toml` runs gitleaks on every commit. `mise.toml` pins bun, gitleaks and prek: run `mise install`, then `prek install`.
- No new dependency unless the user approves.
- Done when `bun run typecheck` is clean and `prek run --all-files` passes.

## Layout

```
src/
  agent.ts prompt.ts triage.ts diagnosis.ts model.ts
  alert.ts config.ts state.ts index.ts
  gcp/      GCP Monitoring webhook + card + incident parsing. GCP re-opens an incident under a new
            incident_id while the condition still holds, so `incident.ts:alertKey` fingerprints the
            labels instead and a re-open patches the first card (config.yaml:notify.flapWindowSeconds).
  harness/  the pi-durable Harness in harness.sqlite next to config.yaml:session.dbPath. One conversation per Lark
            thread (threads.ts, docs.ts). Two durable tasks drive the Lark side: investigation.ts runs the
            investigate and diagnose phases and posts the card, and reply.ts answers one Lark message. A
            message to a busy conversation steers into its run. While the investigation runs, a follow-up
            answers on a fork. tools.ts wraps every tool with the dedup, stagnation and turn-budget gate,
            all rebuilt from the transcript, so a restart resumes every task where it stopped.
            retention.ts deletes threads idle past session.ttlSeconds with SQL on pi-durable's v1 tables,
            because the library has no delete API. It skips threads this process has read (Session cache).
            index.ts runs it with the KV sweep every Monday 03:00 in config.yaml:timezone.
  lark/     Lark client, WS, event parser, handler, card
  session/  incidents, incident-meta, alert groups and thread-message cache in the SQLite/in-memory KV
            store (store.ts). Signed links, the deterministic handoff doc (handoff-doc.ts) and its
            compile step (handoff-synthesis.ts).
  source/   seed-calls loader (seed.ts)
  tools/    agent tools (gcp_logging, prom, movers, jaeger, kubernetes, kafka, registry),
            the progress-card status line (status.ts), and the two submit_diagnosis grounding checks
            (evidence.ts token overlap, grounding.ts System One)
  utils/    timewindow, cap, retry, semaphore, inflight, logger, typesafe, progress, model-error,
            anthropic_* and token-refresh (in-process OAuth rotation), plus the one-shot CLIs refresh-token
            and anthropic-login
scripts/      seed-refresh-token.sh mints an OAuth token and patches the token Secret (auth.md)
protos/       Jaeger gRPC protos
config.yaml   runtime configuration, `${VAR}` interpolated against process.env (config.ts:interp).
              systemContext is the deployment topology the investigate prompt reads.
seed-calls.yaml  alert name → tool calls run before the first turn, local-dev override OPSREMEDY_SEED_CALLS
              Every runtime configuration file must appear in the Dockerfile COPY and the .dockerignore
              allowlist. An unbaked one leaves its feature silently off in the image.
auth.md       OAuth rotation runbook. Read it when an auth error surfaces.
README.md     architecture + tool inventory
```

## Style

**Deterministic first, AI only for decisions.** Reach for `@earendil-works/pi-ai` (`completeSimple`, `getModel`) only where the work needs judgement, such as root-cause synthesis. Parsing, aggregation, dedup, formatting, routing, retries and validation stay in plain TS. Before you add an LLM call, check whether a regex, a set membership, a lookup table, or a deterministic API (Logs Explorer aggregation, Jaeger trace lookup) already answers it. `triage.fastTriage` short-circuits trivial acks that way.

Every call you do make ships with a tight system prompt (exact role, exact output format, banned phrasings, what to do when uncertain), a payload trimmed to that one call, the minimum tool set plus a turn budget, and a deterministic post-check that rejects and retries instead of passing garbage downstream. House specifics:

- Role-based model from `config.yaml:model`: `investigation` for the evidence loop, `synthesis` for diagnosis and follow-ups, both with `reasoning`. Pick a smaller model explicitly for light work (short summaries, intent detection).
- A classification that ends in a branch takes TypeSafe Jev (pi-ai `models.classify()` on `typesafe/jev-latest`) through `utils/typesafe.ts:classifyBool`, not a chat model: `triage.ts` asks two `bool` questions in one call and thresholds the probabilities itself, and `tools/grounding.ts` asks one per diagnosis claim. Jev returns no text, so it cannot be steered by the thread text it reads, and it answers in about 100ms. `TYPESAFE_API_KEY` unset disables both calls: triage then replies to everything, and the grounding gate passes on the token check alone.
- A System One gate must fail open and fail once. `ungroundedClaims` returns no rejections when the call fails, and `submitDiagnosisTool` rejects at most one diagnosis per run, because a probability that disagrees twice would leave the alert card empty.
- `model.ts:models` reads the token through `utils/anthropic_token.getAnthropicToken()` at each request. pi-durable keeps a per-conversation `sessionId` for prompt-cache affinity.
- Each phase owns its model, tools and system prompt: `agent.ts:agentFor` returns the `configure()` change, and a task applies it before it submits the phase's input. Configure only an idle conversation, because a change applies to the next request of a running run. One-shot calls use `model.ts:completeSimple`, never `@earendil-works/pi-ai/compat`.
- An agent run takes a watchdog, not a deadline: `harness/run.ts:waitWithWatchdog` aborts the conversation after `config.yaml:agent.stallSeconds` with no committed progress. Every other call takes an explicit `AbortSignal.timeout` and a fallback that never blocks the request.
- A task phase can run twice after a restart. Submit with a `requestId`, and guard a Lark post with a memo or `ThreadDoc.posted`.
- Alert text, thread history and tool output are untrusted data. Delimit them with `prompt.ts:untrusted`, and never let embedded instructions override the system prompt.

## Prompt language

Every instruction the model reads (`prompt.ts`, tool descriptions) is a procedure run by a reader that cannot ask a question. Write it in the ASD-STE100 discipline the prompts themselves demand: one instruction per sentence, 20 words at most, condition before command, simple tenses, active voice, and `can`/`will`/`must` only. A model reads "should" as optional, drops a trailing condition, and treats check, verify and confirm as three different operations.

Bound answer length with a sentence ceiling, never with a word budget, which the model reads as a target to fill. `VOICE` carries "Answer only what was asked" for every phase.

Output style is a separate axis from prompt style. `VOICE` asks the model for the same plain English, because a Lark card is read by an on-call engineer and many readers are not native speakers. Short is not telegraphic: keep the articles and "that".

Tool descriptions are not held to this yet: rewrite the one you touch, and leave the rest out of an unrelated change.

## Conventions

- `utils/` (not `util/`).
- Server logs go through `utils/logger.ts` only: GCP structured JSON, stdout INFO/WARNING, stderr ERROR. The one-shot CLI entrypoints `utils/refresh-token.ts` and `utils/anthropic-login.ts` may use `console.*`.
- Comments explain a non-obvious constraint or failure mode, never syntax or history. Keep doc URLs in code comments, not in tool descriptions or prompts.
- Card timestamps use `config.yaml:timezone` with an explicit offset (`gcp/card.ts:formatCardTime`). `lark/handler.ts:parseCardTime` reads that format back.
- `OPSREMEDY_WEBHOOK_TOKEN` is non-confidential: query-string auth via `?token=`.
- Lark output stays inside the alert Topic thread. `handler.ts` gates inbound on `msg.threadId`, and `lark/client.ts:replyMessage` always sets `reply_in_thread`.
- Fire-and-forget work goes through `utils/inflight.track()` so SIGTERM drain sees it.

## Tool authoring

- A tool that exposes `startTime`/`endTime` MUST clamp via `tw.clamp({startTime, endTime})`. The agent narrows within the alert window, never widens it. A tool without those args (`jaeger_get_trace`, `prom_series`) reads the raw window via `tw.startISO()/endISO()` or `tw.startUnix()/endUnix()`. `k8s_get_events` reads no window at all, because the kubelet Events API takes no time range and the cluster keeps about 1h, so its description tells the agent to read `lastTimestamp` itself.
- A tool is a `tools/types.ts:SreTool`. `execute(args, tw)` returns `{ content: [{type:'text', text:...}, ...], isError? }`, and the alert window `tw` comes per call from the conversation's `AlertDoc`. Only `harness/tools.ts:submitDiagnosisTool` ends a run, with `control: { terminate: true }` on success.
- `withRetry` wraps every tool with `retry: true`, cheap or not. Each attempt has a 60s deadline, so a hung client cannot hold an investigation slot.
- `withMaxOutput` (32 KB cap) wraps every tool except `submit_diagnosis`, applied in `resolveTools`.
- A tool with `cheap: true` is exempt from the turn budget (`harness/tools.ts:gate`). Discovery tools (`prom_*`, `kafka_list_*`) are cheap.
- State in the description what compaction the tool does (envoy aggregation, per-series stats) and which args narrow the window.
- Never bake a time bound into a filter string the agent supplies (`timestamp>=...` inside a query DSL). The window comes from the args plus `tw.clamp`.
- Never hard-code a deployment value (project, namespace, host) in a tool description. Read it from `Config` in `resolveTools`, as `kubernetesTools(cfg.kubernetes.namespace)` does.

## Adding a tool

1. Define it in `src/tools/<source>.ts` and register it in `resolveTools`.
2. Set `cheap` and `retry` on the `SreTool`. Set `retry: true` if it does a network round-trip. If it is cheap and no prefix in the `prompt.ts` step 1 FREE list covers it (`prom_*`, `kafka_list_*`), name it there, because the exemption is invisible to the agent otherwise.
3. Write the description so the agent knows the defaults and the narrowing args.
4. Add an entry to `session/handoff-doc.ts:QUERY_FORMATTERS` so the call shows up as concrete evidence in a handoff, and in the transcript the handoff compile step reads (`handoff-synthesis.ts` shares that table).
5. Done when `bun run typecheck` is clean.
