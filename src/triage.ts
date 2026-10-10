import { log } from "./utils/logger.ts";
import { ClassifierError, classifyBool, jevAvailable } from "./utils/typesafe.ts";

const QUESTIONS = {
  is_request_to_bot: {
    instructions: "The CURRENT message asks the SRE bot for something.",
    criteria: {
      true:
        "The sender asks the bot a question, requests data or analysis, or assigns it work. " +
        'An imperative that names work only the bot does counts, for example "check the pod logs" or "pull the last hour of errors". ' +
        'A question with no question mark counts, for example "why does it scale to 5 anyway". ' +
        "A polite or acknowledging lead-in does not weaken the request.",
      false:
        "The message is a greeting, thanks, or an acknowledgement of what the bot just said. " +
        "The message states a fact or the sender's own diagnosis and asks nothing, for example \"should be the payment provider's issue\".",
    },
  },
  is_human_to_human: {
    instructions: "The CURRENT message is aimed at another person, not at the bot.",
    criteria: {
      true:
        "The sender answers another person named in the recent messages, coordinates work people do themselves, " +
        'or reports work already done or delegated, for example "I reported to Chris & Frank already".',
      false: "The sender addresses the bot, or addresses nobody in particular.",
    },
  },
} as const;

const TRIVIAL_ACKS = new Set([
  "okay",
  "thanks",
  "thank you",
  "thx",
  "tysm",
  "lgtm",
  "sgtm",
  "noted",
  "got it",
  "gotit",
  "cool",
  "nice",
  "great",
  "good",
  "perfect",
  "yes",
  "yep",
  "nope",
  "hello",
  "hey",
  "bye",
  "done",
  "checking",
]);
const NON_TEXT_RE = /^[\s\p{Emoji_Presentation}\p{Extended_Pictographic}\p{Punctuation}\p{Symbol}]+$/u;
const QUESTION_RE = /^(why|what|whats|when|where|which|who|whom|whose|how)\b/i;

function fastTriage(text: string, hasImages: boolean): "REPLY" | "SKIP" | null {
  const trimmed = text.trim();
  const t = trimmed.toLowerCase().replace(/[.!?]+$/, "");
  if (!t) return hasImages ? "REPLY" : "SKIP";
  if (t.length <= 2) return "SKIP";
  if (TRIVIAL_ACKS.has(t)) return "SKIP";
  if (NON_TEXT_RE.test(trimmed)) return "SKIP";
  if (trimmed.endsWith("?") || QUESTION_RE.test(t)) return "REPLY";
  return null;
}

function verdict(isRequest: number, isHumanToHuman: number): "REPLY" | "SKIP" | null {
  if (isRequest >= 0.5) return "REPLY";
  if (isRequest <= 0.25) return "SKIP";
  return isHumanToHuman >= 0.6 ? "SKIP" : null;
}

export async function triage(
  text: string,
  priorUserTexts: string[] = [],
  hasImages = false,
): Promise<"REPLY" | "SKIP"> {
  const fast = fastTriage(text, hasImages);
  if (fast) {
    log.info("triage fast-path", { decision: fast, text: text.slice(0, 40) });
    return fast;
  }
  if (!jevAvailable()) return "REPLY";
  const recent = priorUserTexts
    .slice(-6)
    .map((t) => t.replace(/\s+/g, " ").trim().slice(0, 400))
    .filter(Boolean);
  try {
    const answers = await classifyBool(
      {
        context: "A Lark alert thread. On-call engineers talk to each other and to an SRE bot.",
        recent_user_messages: recent,
        current_message: { text, has_attached_image: hasImages },
      },
      QUESTIONS,
      2_500,
    );
    const isRequest = answers.is_request_to_bot;
    const isHumanToHuman = answers.is_human_to_human;
    if (isRequest === undefined || isHumanToHuman === undefined) throw new Error("Jev answered no triage question");
    const decision = verdict(isRequest, isHumanToHuman);
    log.info("triage", {
      decision: decision ?? "AMBIGUOUS→REPLY",
      isRequest,
      isHumanToHuman,
      text: text.slice(0, 40),
    });
    return decision ?? "REPLY";
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    if (e instanceof ClassifierError && e.rejectedKey) {
      log.error("TypeSafe rejected the triage key; reseed TYPESAFE_API_KEY", undefined, {
        detail: err.slice(0, 200),
      });
    } else {
      log.warn("triage failed; falling back to REPLY", { error: err });
    }
    return "REPLY";
  }
}
