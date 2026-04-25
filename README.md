# OpsRemedy

AI SRE investigation agent. Two-phase (gather evidence → diagnose root cause) over GCP Cloud Logging, Prometheus, Jaeger, and Kubernetes. Built on Bun and `@mariozechner/pi-agent-core`.

Status: alpha — scaffolding. See [`plan.md`](./plan.md) for the full build plan.

## Install

```bash
bun install
cp .env.example .env      # fill in your credentials
```

## Usage

```bash
# Run an investigation against a real cluster
bun run investigate -i examples/alerts/sample-k8s-alert.json

# Run the synthetic benchmark suite (fixture-backed, no real infra needed)
bun run bench
bun run bench -- --scenario 001-oom-kill
```

## Layout

- `packages/core` — orchestration (gather + diagnose)
- `packages/clients` — GCP / Prometheus / Jaeger / K8s adapters (real + fixture)
- `packages/tools` — AgentTool factories
- `packages/cli` — binary entry point
- `packages/bench` — synthetic scenario runner
</content>
