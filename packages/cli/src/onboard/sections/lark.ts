import { confirm, input, password, select } from "@inquirer/prompts";
import type { Alert } from "@opsremedy/core/types";
import { ZERO_USAGE } from "@opsremedy/core/types";
import {
  buildRcaCard,
  buildSendUuid,
  DEFAULT_LARK_DOMAIN,
  DEFAULT_LARK_LOCALE,
  DEFAULT_LARK_RECEIVE_TYPE,
  DEFAULT_LARK_SEND_ON,
  DEFAULT_LOW_CONFIDENCE_THRESHOLD,
  type LarkConfig,
  sendLarkCard,
} from "@opsremedy/notify";
import type { OpsremedyConfig, OpsremedyCredentials } from "../../config.ts";

export interface LarkAnswers {
  fileShape: NonNullable<OpsremedyConfig["lark"]>;
  appId: string | undefined;
  appSecret: string | undefined;
}

/**
 * Optional Lark notifications section. Off by default; if enabled, collects
 * app credentials, target chat, and send policy. Offers a one-shot test card
 * before saving so a misconfigured webhook is caught immediately.
 */
export async function sectionLark(cfg: OpsremedyConfig, creds: OpsremedyCredentials): Promise<LarkAnswers> {
  console.log("\n== Lark notifications (optional) ==");
  const enable = await confirm({
    message: "Enable Lark notifications?",
    default: cfg.lark?.enabled === true,
  });
  if (!enable) {
    return {
      fileShape: { enabled: false },
      appId: undefined,
      appSecret: undefined,
    };
  }

  const domain = (await select({
    message: "Domain",
    choices: [
      { name: "Lark international (open.larksuite.com)", value: "lark" },
      { name: "Feishu CN (open.feishu.cn)", value: "feishu" },
    ],
    default: cfg.lark?.domain ?? DEFAULT_LARK_DOMAIN,
  })) as "lark" | "feishu";

  const appId = await input({
    message: "Lark app id (cli_...)",
    default: creds.lark?.app_id ?? "",
    validate: (v) => v.trim().length > 0 || "required",
  });

  const appSecret = await password({
    message: "Lark app secret",
    mask: "*",
    validate: (v) => v.length > 0 || "required",
  });

  const receiveIdType = (await select({
    message: "Receive ID type",
    choices: [
      { name: "chat_id (group)", value: "chat_id" },
      { name: "open_id (user)", value: "open_id" },
      { name: "user_id", value: "user_id" },
      { name: "union_id", value: "union_id" },
      { name: "email", value: "email" },
    ],
    default: cfg.lark?.receive_id_type ?? DEFAULT_LARK_RECEIVE_TYPE,
  })) as LarkConfig["receiveIdType"];

  const receiveId = await input({
    message: `Receive ID (${receiveIdType})`,
    default: cfg.lark?.receive_id ?? "",
    validate: (v) => v.trim().length > 0 || "required",
  });

  const sendOn = (await select({
    message: "Send policy",
    choices: [
      { name: "non_healthy — skip healthy short-circuits", value: "non_healthy" },
      { name: "always — send every investigation", value: "always" },
      { name: "low_confidence — only when below threshold", value: "low_confidence" },
    ],
    default: cfg.lark?.send_on ?? DEFAULT_LARK_SEND_ON,
  })) as LarkConfig["sendOn"];

  const locale = (await select({
    message: "Locale",
    choices: [
      { name: "en_US", value: "en_US" },
      { name: "zh_CN", value: "zh_CN" },
    ],
    default: cfg.lark?.locale ?? DEFAULT_LARK_LOCALE,
  })) as LarkConfig["locale"];

  const cfgFile: NonNullable<OpsremedyConfig["lark"]> = {
    enabled: true,
    domain,
    receive_id_type: receiveIdType,
    receive_id: receiveId,
    locale,
    send_on: sendOn,
    low_confidence_threshold: DEFAULT_LOW_CONFIDENCE_THRESHOLD,
  };

  const wantTest = await confirm({
    message: "Send a test card now to verify?",
    default: true,
  });
  if (wantTest) {
    const resolved: LarkConfig = {
      enabled: true,
      domain,
      appId,
      appSecret,
      receiveIdType,
      receiveId,
      locale,
      sendOn,
      lowConfidenceThreshold: DEFAULT_LOW_CONFIDENCE_THRESHOLD,
    };
    await sendTestCard(resolved);
  }

  return { fileShape: cfgFile, appId, appSecret };
}

async function sendTestCard(cfg: LarkConfig): Promise<void> {
  const alert: Alert = {
    alert_id: "onboard-test",
    alert_name: "OpsRemedy onboarding test",
    severity: "info",
    fired_at: new Date().toISOString(),
    labels: {},
    annotations: {},
    summary: "If you see this, Lark notifications are configured correctly.",
  };
  const card = buildRcaCard(
    {
      alert_id: alert.alert_id,
      root_cause: "This is a test card from `opsremedy onboard`. No real incident.",
      root_cause_category: "healthy",
      confidence: 1,
      causal_chain: ["Wizard collected Lark credentials", "Test card dispatched"],
      validated_claims: [{ claim: "Lark app credentials accepted", evidence_sources: ["onboard"] }],
      unverified_claims: [],
      remediation: [],
      tools_called: [],
      duration_ms: 0,
      usage: ZERO_USAGE,
    },
    alert,
  );
  try {
    const res = await sendLarkCard(cfg, card, buildSendUuid(alert.alert_id));
    console.log(`  test card sent (message_id=${res.messageId})`);
  } catch (e) {
    console.log(`  test card failed: ${(e as Error).message}`);
    const cont = await confirm({ message: "Save Lark config anyway?", default: false });
    if (!cont) throw new Error("aborted lark setup");
  }
}
