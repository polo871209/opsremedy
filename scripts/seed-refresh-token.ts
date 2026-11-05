#!/usr/bin/env bun
// Mint an Anthropic OAuth token with a browser login and patch it into the token Secret. Runbook: auth.md.
import { $ } from "bun";
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { credsToSecretFields } from "../src/utils/token-refresh.ts";

const context = process.env.KUBE_CONTEXT;
if (!context)
  throw new Error(
    "set KUBE_CONTEXT to the kubectl context of the cluster that runs opsremedy",
  );
const namespace = process.env.NAMESPACE ?? "opsremedy";
const secret = process.env.SECRET_NAME ?? "anthropic-auth";

const oauth = anthropicProvider().auth.oauth;
if (!oauth) throw new Error("anthropic provider exposes no oauth flow");

const stdin = console[Symbol.asyncIterator]();
async function ask(question: string): Promise<string> {
  process.stderr.write(question);
  const line = await stdin.next();
  if (line.done) throw new Error("stdin closed before an answer");
  return line.value.trim();
}

console.error(
  "--> log into the dedicated bot account in a private browser window",
);
const creds = await oauth.login({
  signal: new AbortController().signal,
  prompt: async (p: AuthPrompt) => {
    if (p.type !== "select") return ask(`${p.message} `);
    console.error(p.message);
    p.options.forEach((o, i) => console.error(`  ${i + 1}. ${o.label}`));
    const answer = (await ask(`Choose 1-${p.options.length} [1]: `)) || "1";
    const picked = p.options[Number(answer) - 1];
    if (!picked) throw new Error(`no option ${answer}`);
    return picked.id;
  },
  notify: (ev: AuthEvent) => {
    if (ev.type === "auth_url") {
      console.error(`\nOpen this URL in your browser:\n\n${ev.url}\n`);
      if (ev.instructions) console.error(ev.instructions);
    } else if (ev.type === "info" || ev.type === "progress") {
      console.error(ev.message);
    }
  },
});

for (const [name, token] of [
  ["refresh", creds.refresh],
  ["access", creds.access],
] as const) {
  if (!token.startsWith("sk-ant-"))
    throw new Error(
      `login ${name} token has an unexpected prefix; secret untouched`,
    );
}
if (!/^\d{13}$/.test(String(creds.expires)))
  throw new Error(
    `login expiry is not epoch milliseconds: ${creds.expires}; secret untouched`,
  );

const patch = new Response(
  JSON.stringify({ stringData: credsToSecretFields(creds) }),
);
await $`kubectl --context ${context} -n ${namespace} patch secret ${secret} --type=merge --patch-file=/dev/stdin < ${patch}`.quiet();
console.error(
  "--> secret patched. The pod picks it up within about 60 seconds",
);

const { data } =
  await $`kubectl --context ${context} -n ${namespace} get secret ${secret} -o json`.json();
console.error(Object.keys(data).join("\n"));
process.exit(0);
