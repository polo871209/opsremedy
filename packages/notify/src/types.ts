/**
 * Lark notifier configuration. Loaded from config.yml + credentials.yml +
 * env, mirrored into ResolvedSettings by the CLI. All fields here are
 * post-resolution (no Optional wrappers for missing files).
 */
export interface LarkConfig {
  enabled: boolean;
  /** "lark" → open.larksuite.com (intl); "feishu" → open.feishu.cn (cn). */
  domain: "lark" | "feishu";
  appId: string;
  appSecret: string;
  receiveIdType: "open_id" | "user_id" | "union_id" | "email" | "chat_id";
  receiveId: string;
  locale: "en_US" | "zh_CN";
  sendOn: SendPolicy;
  /** Used only when sendOn === "low_confidence". */
  lowConfidenceThreshold: number;
}

export type SendPolicy = "always" | "non_healthy" | "low_confidence";

export const DEFAULT_LARK_DOMAIN: LarkConfig["domain"] = "lark";
export const DEFAULT_LARK_RECEIVE_TYPE: LarkConfig["receiveIdType"] = "chat_id";
export const DEFAULT_LARK_LOCALE: LarkConfig["locale"] = "en_US";
export const DEFAULT_LARK_SEND_ON: SendPolicy = "non_healthy";
export const DEFAULT_LOW_CONFIDENCE_THRESHOLD = 0.5;

/**
 * Lark message-card v1 envelope with the modern `markdown` element.
 * Matches the shape the official @larksuiteoapi/node-sdk README ships.
 */
export interface CardEnvelope {
  config: { wide_screen_mode: boolean };
  header: {
    template: CardTemplate;
    title: { tag: "plain_text"; content: string };
  };
  elements: CardElement[];
}

export type CardTemplate =
  | "blue"
  | "wathet"
  | "turquoise"
  | "green"
  | "yellow"
  | "orange"
  | "red"
  | "carmine"
  | "violet"
  | "purple"
  | "indigo"
  | "grey";

export type CardElement =
  | { tag: "markdown"; content: string }
  | { tag: "hr" }
  | {
      tag: "action";
      actions: Array<{
        tag: "button";
        text: { tag: "plain_text"; content: string };
        type: "default" | "primary" | "danger";
        url: string;
      }>;
    };
