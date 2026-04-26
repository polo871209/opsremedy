# @opsremedy/clients

Data-source adapters: GCP Cloud Logging, Prometheus, Jaeger, Kubernetes.
Each source has a `Real*` impl (production) and a `Fixture*` impl (bench).

## Registry pattern

Tools never import a client directly. They call `getClients().<source>` so
the active set can be swapped at runtime:

- CLI calls `setClients(...)` from `bootstrapRealClients` with real impls.
- Bench calls `resetClients()` then `setClients(loadScenarioClients(dir))`
  per scenario.
- Default registry throws to fail loudly if nothing was wired.

## Subpath exports

Tools and CLI import from narrow subpaths to keep dependency graphs clean:

- `@opsremedy/clients/types` — interfaces + query shapes
- `@opsremedy/clients/{gcp,prom,jaeger,k8s}` — `Real*` clients
- `@opsremedy/clients/fixtures` — `loadScenarioClients(dir)`

## Key files

| file | role |
|------|------|
| `index.ts` | registry (`getClients`/`setClients`/`resetClients`) + barrel |
| `types.ts` | `*Client` interfaces and `*Query` shapes |
| `fixtures.ts` | bench scenario loader |
| `gcp/real.ts` | Cloud Logging via `@google-cloud/logging` |
| `prom/real.ts` | Prom HTTP API via `fetch` |
| `jaeger/real.ts` | Jaeger Query API via `fetch` |
| `k8s/real.ts` | Kubernetes via `@kubernetes/client-node` v1.x |

All operations are **read-only**. Adding a mutating client requires
explicit user opt-in.
