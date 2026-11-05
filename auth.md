# Anthropic OAuth

The opsremedy pod refreshes its own OAuth token. `src/utils/anthropic_token.ts:SecretCredentialStore` is the pi-ai `CredentialStore` for `models`. When a model request finds less than 5 minutes of life left, pi-ai refreshes the token inside the store lock, so concurrent requests refresh once. The store patches the rotated pair back into the token Secret. The Secret is `anthropic-auth` in namespace `opsremedy` by default, and the `SECRET_NAME` and `NAMESPACE` env vars override it.

All three keys of that Secret are mounted as files under `/var/run/opsremedy`. The pod reads the files until its first refresh. After that, it keeps the rotated pair in memory, and it reads the files again only after a refresh fails with `invalid_grant`. The kubelet syncs a patched Secret into the files within about 60 seconds, with no rollout.

A `Bun.cron` tick every 5 minutes calls `models.getAuth("anthropic")`, so an idle pod also refreshes before expiry. A refresh does not wait for in-flight work. A rotation can land between two model calls of one investigation, and the next call uses the new token.

A stored credential owns the provider, so `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_OAUTH_TOKEN` in the environment are ignored while the Secret holds a refresh token.

Use a dedicated bot account. Never use a personal account, share its login, or reuse its refresh token locally. Refresh tokens are one-time use, so a second refresh anywhere invalidates the value the pod holds.

## Reseed when

- First-time setup.
- The pod logs `invalid_grant`, or `anthropic refresh token rejected`.
- The pod logs `no ANTHROPIC_REFRESH_TOKEN in the mounted secret`. Check the Secret first: if it holds all three keys, the mount is wrong, not the credential.
- The pod logs `429 rate_limit_error`.
- An alert thread reports that the Anthropic credential was rejected. The agent posts that line in place of the provider 401, and logs `anthropic credential rejected` at ERROR.

## 1. Mint a refresh token and update the secret

Run this on your laptop, in a real terminal, because the login prompts need a TTY:

```bash
KUBE_CONTEXT=<context> NAMESPACE=<namespace> scripts/seed-refresh-token.sh
```

The script asks for a login method. If the browser runs on the same machine, pick browser login. If it does not, pick copy code login and paste the code that Anthropic shows. In both cases, log into the dedicated bot account in a private browser window when the URL is printed. The script pipes the JSON output of `anthropic-login.ts` straight into `kubectl patch`, so the tokens never reach a ticket, chat, or shell history.

The running pod adopts the reseeded credential on its own. It drops the credential it holds as soon as its own refresh returns `invalid_grant`, then reads the mounted Secret again on the next request or tick. If you need the switch immediately, restart the Deployment:

```bash
kubectl -n <namespace> rollout restart deployment/opsremedy
```

## 2. Make sure that the refresh runs, without exposing tokens

```bash
kubectl -n <namespace> logs deployment/opsremedy | grep -E 'token refresh|token refreshed'
```

Expected fields: `token refresh scheduled` with `armed: true` at startup, then `anthropic token refreshed` with an expiry timestamp and no token value or prefix. `token refresh deferred: work in flight` is normal while an investigation runs. Do not print or compare token contents.

`armed: false` means the pod sees no refresh token. List what the mount carries:

```bash
kubectl -n <namespace> exec deployment/opsremedy -- ls /var/run/opsremedy
```

All three keys must be listed. One file alone means the Deployment carries an `items` allowlist on the Secret volume.

## 3. Refresh out of band

Use this only when the pod cannot refresh itself, for example in a crash loop:

```bash
ANTHROPIC_REFRESH_TOKEN=... bun src/utils/refresh-token.ts
```

This spends the refresh token, so a healthy pod recovers from it on its next tick. Add `DRY_RUN=1` to print the fields instead of patching.

## TypeSafe Jev key

`TYPESAFE_API_KEY` turns on two checks. A failed or missing key does not stop the pod, but it turns both checks off:

- Follow-up triage replies to every message in an alert thread.
- The `submit_diagnosis` grounding gate passes on the token-overlap check alone.

Reseed when the pod logs `TypeSafe rejected the triage key` or `TypeSafe client unavailable`. The pod reads the key from the environment once at startup, so a patch needs a restart.

## Files

- `src/utils/token-refresh.ts`: in-process refresh schedule, provider call, Secret patch.
- `src/utils/anthropic_token.ts`: credential store read by every model call.
- `src/utils/model-error.ts`: maps a rejected credential to the reseed instruction the thread shows.
- `src/utils/refresh-token.ts`: out-of-band CLI refresh.
- `src/utils/anthropic-login.ts`: local OAuth helper, run by `scripts/seed-refresh-token.sh`.
- `src/utils/typesafe.ts`: TypeSafe client for triage and grounding, built once from `TYPESAFE_API_KEY`.

## Troubleshoot

| Symptom                     | Fix                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------ |
| `429 rate_limit_error`      | Stop sharing the credential, then reseed with the dedicated account.                       |
| `invalid_grant` (400)       | The refresh token was rotated elsewhere. Reseed.                                           |
| `token secret patch failed` | Give the pod's service account `patch` on the token Secret. A restart then needs a reseed. |
| `EADDRINUSE :53692`         | Stop the local listener, then retry the login helper.                                      |
| `State mismatch`            | Use only the URL printed by the current login-helper run in a fresh tab.                   |
| Pod uses an old token       | Check the Secret volume mount and `utils/anthropic_token.ts`. Never expose token contents. |
