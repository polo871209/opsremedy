import { credsToSecretFields, patchTokenSecret, refreshCreds } from "./token-refresh.ts";

const refreshToken = process.env.ANTHROPIC_REFRESH_TOKEN;
if (!refreshToken) {
  console.error("ANTHROPIC_REFRESH_TOKEN not set");
  process.exit(1);
}

const creds = await refreshCreds(refreshToken);
console.log(
  JSON.stringify({
    expires_iso: new Date(creds.expires).toISOString(),
    rotated_refresh: creds.refresh !== refreshToken,
  }),
);

if (process.env.DRY_RUN) {
  console.log("DRY_RUN — would patch", {
    ns: process.env.NAMESPACE ?? "opsremedy",
    name: process.env.SECRET_NAME ?? "anthropic-auth",
    keys: Object.keys(credsToSecretFields(creds)),
  });
  process.exit(0);
}

await patchTokenSecret(creds);
console.log("ok");
