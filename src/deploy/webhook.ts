import { arr, bool, compile, nullable, obj, oneOf, opt, str, type Static } from "@earendil-works/pi-schema";
import { state } from "../state.ts";
import { log } from "../utils/logger.ts";
import { verifyDeployToken, type DeployRun } from "./oidc.ts";
import type { DeployTarget } from "./target.ts";
import { startDeployWatch } from "./watch.ts";

const K8S_NAME = "^[a-z0-9]([-a-z0-9]*[a-z0-9])?$";
const MAX_GROUPS = 50;
const MAX_AGE_MS = 6 * 60 * 60 * 1000;
const MAX_REPORTED_ERRORS = 5;

const open = { open: true } as const;
const k8sName = str({ pattern: K8S_NAME });

const RolloutSchema = obj(
  {
    deployment: k8sName,
    namespace: k8sName,
    container: k8sName,
    k8sService: nullable(k8sName),
    appType: oneOf(["api", "worker"]),
    critical: opt(bool()),
    rollout: obj(
      { appliedAt: str(), finishedAt: str(), result: oneOf(["success", "failure", "cancelled", "skipped"]) },
      open,
    ),
  },
  open,
);

const ConsumersSchema = obj(
  {
    groups: arr(str({ pattern: "^[A-Za-z0-9._-]+$" }), { maxItems: MAX_GROUPS }),
    unresolved: arr(str(), { maxItems: MAX_GROUPS }),
  },
  open,
);

const ServiceSchema = obj(
  {
    name: str({ pattern: "^[a-z0-9][a-z0-9.-]*$" }),
    rollout: opt(nullable(RolloutSchema)),
    consumers: opt(nullable(ConsumersSchema)),
  },
  open,
);

const BodySchema = obj(
  {
    messageId: str({ pattern: "^om_[A-Za-z0-9_-]+$" }),
    services: arr(ServiceSchema, { minItems: 1, maxItems: 100 }),
  },
  open,
);

const body = compile(BodySchema);

class BadRequest extends Error {}

function fail(message: string): never {
  throw new BadRequest(message);
}

function time(iso: string, at: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms) || ms > Date.now() + 60_000 || Date.now() - ms > MAX_AGE_MS)
    fail(`${at} must be an ISO time in the last 6 hours`);
  return ms;
}

function target(
  name: string,
  r: Static<typeof RolloutSchema>,
  consumers: Static<typeof ConsumersSchema> | null,
): DeployTarget {
  const at = `services.${name}`;
  const appliedAtMs = time(r.rollout.appliedAt, `${at}.appliedAt`);
  const finishedAtMs = time(r.rollout.finishedAt, `${at}.finishedAt`);
  if (finishedAtMs < appliedAtMs) fail(`${at}.finishedAt is before appliedAt`);
  return {
    service: name,
    deployment: r.deployment,
    namespace: r.namespace,
    container: r.container,
    k8sService: r.k8sService,
    appType: r.appType,
    critical: r.critical === true,
    rolloutResult: r.rollout.result,
    appliedAtMs,
    finishedAtMs,
    consumerGroups: consumers ? [...new Set(consumers.groups)] : null,
    unresolvedGroups: consumers ? [...new Set(consumers.unresolved.map((s) => s.slice(0, 200)))] : [],
  };
}

type Body = { messageId: string; targets: DeployTarget[]; unwatched: string[] };

function parseBody(raw: unknown): Body {
  if (!body.check(raw)) {
    const errors = body.errors(raw).slice(0, MAX_REPORTED_ERRORS);
    fail(errors.map((e) => `${e.path || "body"}: ${e.message}`).join("; "));
  }
  const targets: DeployTarget[] = [];
  const unwatched: string[] = [];
  for (const s of raw.services) {
    if (s.rollout == null) unwatched.push(s.name);
    else targets.push(target(s.name, s.rollout, s.consumers ?? null));
  }
  return { messageId: raw.messageId, targets, unwatched };
}

export async function handleDeployWatch(req: Request): Promise<Response> {
  const { cfg } = state();
  if (!cfg.deploy) return Response.json({ error: "deploy watch is not configured" }, { status: 404 });
  const auth = req.headers.get("authorization") ?? "";
  let run: DeployRun;
  try {
    run = await verifyDeployToken(auth.replace(/^Bearer /, ""), cfg.publicBaseUrl, cfg.deploy);
  } catch (e) {
    log.warn("deploy watch auth rejected", { error: String(e) });
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: Body;
  try {
    body = parseBody(await req.json().catch(() => null));
  } catch (e) {
    if (e instanceof BadRequest) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
  if (!body.targets.length) {
    log.info("deploy watch skipped: no rollout facts", { run: run.runId, unwatched: body.unwatched });
    return Response.json({ ok: true, created: false, reason: "no rollout facts" }, { status: 200 });
  }
  const created = await startDeployWatch({ threadKey: body.messageId, run, ...body });
  log.info("deploy watch requested", {
    root: body.messageId,
    run: run.runId,
    attempt: run.runAttempt,
    targets: body.targets.length,
    unwatched: body.unwatched.length,
    created,
  });
  return Response.json({ ok: true, created }, { status: created ? 202 : 200 });
}
