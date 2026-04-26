# @opsremedy/cli

Bun CLI. Wires real clients into the registry, runs the investigation
pipeline, prints JSON to stdout + progress events to stderr.

## Commands

```
opsremedy onboard                          # interactive setup wizard
opsremedy investigate -i alert.json        # run on local alert JSON
opsremedy investigate --url '<gcp-url>'    # fetch alert from GCP first
opsremedy bench [--scenario <id>]          # run scenario suite
```

`investigate` flags: `--markdown <path>`, `--trace <path>`, `--max-tool-calls N`,
`--quiet`. `bench` flags: `--json`, `--quiet`.

## Config locations

| file | purpose |
|------|---------|
| `$XDG_CONFIG_HOME/opsremedy/config.yml` | non-secret URLs, model, project, k8s context |
| `$XDG_DATA_HOME/opsremedy/credentials.yml` | API keys + OAuth tokens (chmod 0600) |

Resolution order: env > file > default. See `config.ts:resolveSettings`.

## Key files

| file | role |
|------|------|
| `main.ts` | dispatcher, arg parser, markdown report renderer |
| `bootstrap.ts` | load config + creds, refresh OAuth, wire real clients |
| `config.ts` | YAML load/save, `ResolvedSettings`, env-var injection |
| `oauth.ts` | pi-ai OAuth login + token refresh |
| `discover.ts` | gcloud / kubeconfig / Prom-Jaeger probes; env-var name discovery |
| `gcp-alert.ts` | parse GCP Monitoring URL → fetch alert via REST |
| `onboard/index.ts` | wizard orchestrator; sections in `onboard/sections/` |

## Install link

```
cd packages/cli && bun link
export PATH="$HOME/.bun/bin:$PATH"
```

Run from source without linking: `bun packages/cli/src/main.ts <command>`.
