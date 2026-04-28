import { afterEach, describe, expect, test } from "bun:test";
import type { CardEnvelope, LarkConfig } from "../types.ts";
import { buildSendUuid, type LarkSendClient, resetLarkClient, sendLarkCard, setLarkClient } from "./send.ts";

const CFG: LarkConfig = {
  enabled: true,
  domain: "lark",
  appId: "cli_x",
  appSecret: "s",
  receiveIdType: "chat_id",
  receiveId: "oc_target",
  locale: "en_US",
  sendOn: "non_healthy",
  lowConfidenceThreshold: 0.5,
};

const CARD: CardEnvelope = {
  config: { wide_screen_mode: true },
  header: {
    template: "red",
    title: { tag: "plain_text", content: "test" },
  },
  elements: [{ tag: "markdown", content: "hi" }],
};

function fakeClient(impl: LarkSendClient["im"]["message"]["create"]): LarkSendClient {
  return { im: { message: { create: impl } } };
}

afterEach(() => resetLarkClient());

describe("sendLarkCard", () => {
  test("happy path: stringifies card, returns message id", async () => {
    type CaptureArgs = Parameters<LarkSendClient["im"]["message"]["create"]>[0];
    const seen: CaptureArgs[] = [];
    setLarkClient(
      fakeClient(async (args) => {
        seen.push(args);
        return { code: 0, msg: "ok", data: { message_id: "om_1" } };
      }),
    );
    const result = await sendLarkCard(CFG, CARD, "uuid-123");
    expect(result.messageId).toBe("om_1");
    const captured = seen[0];
    expect(captured).toBeDefined();
    if (!captured) throw new Error("no capture");
    expect(captured.params.receive_id_type).toBe("chat_id");
    expect(captured.data.receive_id).toBe("oc_target");
    expect(captured.data.msg_type).toBe("interactive");
    expect(captured.data.uuid).toBe("uuid-123");
    const decoded = JSON.parse(captured.data.content);
    expect(decoded.header.template).toBe("red");
  });

  test("non-zero code throws with message", async () => {
    setLarkClient(fakeClient(async () => ({ code: 230002, msg: "bot not in group" })));
    let err: unknown;
    try {
      await sendLarkCard(CFG, CARD, "u");
    } catch (e) {
      err = e;
    }
    expect((err as Error)?.message).toContain("230002");
    expect((err as Error)?.message).toContain("bot not in group");
  });

  test("uuid clipped to 50 chars", async () => {
    let captured = "";
    setLarkClient(
      fakeClient(async (args) => {
        captured = args.data.uuid ?? "";
        return { code: 0, data: { message_id: "m" } };
      }),
    );
    await sendLarkCard(CFG, CARD, "x".repeat(80));
    expect(captured.length).toBe(50);
  });
});

describe("buildSendUuid", () => {
  test("same alert + same 15-min bucket → same uuid", () => {
    const t = 1_700_000_000_000;
    expect(buildSendUuid("a-1", t)).toBe(buildSendUuid("a-1", t + 1000));
  });

  test("different buckets → different uuid", () => {
    const t = 1_700_000_000_000;
    expect(buildSendUuid("a-1", t)).not.toBe(buildSendUuid("a-1", t + 16 * 60 * 1000));
  });

  test("never exceeds 50 chars", () => {
    const long = "a".repeat(80);
    expect(buildSendUuid(long, 0).length).toBeLessThanOrEqual(50);
  });
});
