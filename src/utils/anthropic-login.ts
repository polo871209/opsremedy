import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import readline from "node:readline/promises";

const rl = readline.createInterface({ input: process.stdin, output: process.stderr });

const oauth = anthropicProvider().auth.oauth;
if (!oauth) throw new Error("anthropic provider exposes no oauth flow");

const creds = await oauth.login({
  signal: new AbortController().signal,
  prompt: async (p: AuthPrompt) => {
    if (p.type !== "select") return rl.question(p.message + " ");
    console.error(p.message);
    p.options.forEach((o, i) => console.error(`  ${i + 1}. ${o.label}`));
    const answer = (await rl.question(`Choose 1-${p.options.length} [1]: `)).trim() || "1";
    const picked = p.options[Number(answer) - 1];
    if (!picked) throw new Error(`no option ${answer}`);
    return picked.id;
  },
  notify: (ev: AuthEvent) => {
    if (ev.type === "auth_url") {
      console.error("\nOpen this URL in your browser:\n\n" + ev.url + "\n");
      if (ev.instructions) console.error(ev.instructions);
    } else if (ev.type === "info" || ev.type === "progress") {
      console.error(ev.message);
    }
  },
});

rl.close();

console.log(JSON.stringify(creds, null, 2));
