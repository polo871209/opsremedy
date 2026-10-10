import { log } from "../utils/logger.ts";
import { buildHandoffMarkdown } from "./handoff-doc.ts";
import { sessionUrl } from "./link.ts";
import { resolveSessionLink } from "./dump.ts";
import { getHandoff, threadTranscript } from "../harness/threads.ts";
import { prefersHtml, renderHandoffHtml } from "./handoff-html.ts";

export async function handleHandoffDump(
  req: Request & { params: { threadKey: string; token: string } },
): Promise<Response> {
  const resolved = await resolveSessionLink(req, () =>
    Response.json(
      {
        error: "no stored session for this thread; post 'handoff' in the Lark thread to rebuild it from thread history",
      },
      { status: 404 },
    ),
  );
  if (resolved instanceof Response) return resolved;
  const { threadKey, meta } = resolved;
  const messages = await threadTranscript(threadKey);

  const compiled = await getHandoff(threadKey).catch(() => undefined);
  const md = buildHandoffMarkdown(threadKey, meta, messages, sessionUrl(threadKey), compiled);

  const html = prefersHtml(req);
  log.info("handoff dumped", { thread: threadKey, msgCount: messages.length, compiled: !!compiled, html });
  return new Response(html ? renderHandoffHtml(md, `Handoff: ${meta.alertName}`) : md, {
    headers: {
      "content-type": html ? "text/html; charset=utf-8" : "text/markdown; charset=utf-8",
      // The body depends on the request headers, so a shared cache must not
      // hand a browser's HTML to an agent asking for the same URL.
      vary: "accept, user-agent",
    },
  });
}
