import { log } from "../utils/logger.ts";
import { verifySessionToken, SESSION_SECRET } from "./link.ts";
import { threadMeta, threadTranscript, type ThreadMeta } from "../harness/threads.ts";

export async function resolveSessionLink(
  req: Request & { params: { threadKey: string; token: string } },
  notFound: () => Response,
): Promise<{ threadKey: string; meta: ThreadMeta } | Response> {
  if (!SESSION_SECRET) return Response.json({ error: "session links disabled" }, { status: 503 });

  const threadKey = req.params.threadKey;
  const token = req.params.token;
  if (!threadKey || !token) return Response.json({ error: "missing threadKey or token" }, { status: 400 });
  if (!verifySessionToken(threadKey, token)) {
    return Response.json(
      { error: "invalid or expired link; post 'handoff' in the Lark thread to get a fresh one" },
      { status: 410 },
    );
  }

  const meta = await threadMeta(threadKey);
  if (!meta) return notFound();
  return { threadKey, meta };
}

export async function handleSessionDump(
  req: Request & { params: { threadKey: string; token: string } },
): Promise<Response> {
  const resolved = await resolveSessionLink(req, () =>
    Response.json({ error: "session not found or expired" }, { status: 404 }),
  );
  if (resolved instanceof Response) return resolved;
  const { threadKey, meta } = resolved;
  const messages = await threadTranscript(threadKey);

  log.info("session dumped", { thread: threadKey, msgCount: messages.length });
  return Response.json(
    {
      threadKey,
      alertName: meta.alertName,
      alertStartedAt: meta.alertStartedAt,
      alertEndedAt: meta.alertEndedAt,
      createdAt: meta.createdAt,
      messages,
    },
    { headers: { "content-type": "application/json; charset=utf-8" } },
  );
}
