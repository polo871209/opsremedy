# AGENTS.md

Bun + TypeScript monorepo. Keep changes small, readable, and boring.

## Goal

Investigate with AI, but use as little AI as possible. Prefer deterministic logic, parsing, filtering, scoring, and evidence reduction before calling an agent.

## Structure

- `packages/core` — investigation pipeline, prompts, diagnosis, validation, evidence rendering.
- `packages/tools` — agent tools. Tools gather evidence only; no mutation of cluster/cloud.
- `packages/clients` — real + fixture clients for GCP, Prometheus, Jaeger, Kubernetes.
- `packages/cli` — thin command shell: onboard, investigate, bench, input/output wiring.
- `packages/bench` — fixture scenarios and scoring.
- `packages/notify` — Lark card build/send.

Keep features in `core`, `tools`, `clients`, or `notify` when possible. CLI should stay thin.

## Rules

- `investigate` is read-only. `propose_remediation` records suggestions, never executes them.
- Agent may run against production kube contexts. Do not add write-capable tools unless explicitly asked.
- Preserve subpath exports used across packages, especially `@opsremedy/core/types` and `@opsremedy/clients/*`.
- Match nearby code when touching clients, tools, or notifications.

## Style

- Comments: short WHY only. No banners. No obvious comments.
- Prefer descriptive names over comments.
- Prefer simple code over clever abstractions.
- No new dependency unless user approves.
