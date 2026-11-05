import { parseArticle } from "./article.ts";
import type { CvssScore } from "./cvss.ts";
import type { FeedItem } from "./rss.ts";

const CVE_ID = /^CVE-\d{4}-\d+$/;
const ACTION_BANNER = /^(.+?) · Last checked (.+)$/;
const MD_ESCAPES: Record<string, string> = {
  "<": "&lt;",
  ">": "&gt;",
  "*": "&#42;",
  _: "&#95;",
  "~": "&sim;",
  "[": "&#91;",
  "]": "&#93;",
  "`": "&#96;",
};

// Feed text is untrusted: escaped, it cannot add an @all mention, a link or formatting to the card.
function md(text: string): string {
  return text.replace(/[<>*_~[\]`]/g, (c) => MD_ESCAPES[c]!);
}

export function cveIds(item: FeedItem): string[] {
  return item.categories.filter((c) => CVE_ID.test(c.label)).map((c) => c.label);
}

const SEVERITY_TEMPLATE: Record<string, string> = { CRITICAL: "red", HIGH: "orange", MEDIUM: "yellow", LOW: "blue" };

function headerTemplate(needsAttention: boolean, cvss: CvssScore | undefined): string {
  if (!needsAttention) return "grey";
  return SEVERITY_TEMPLATE[cvss?.severity.toUpperCase() ?? ""] ?? "orange";
}

function textTag(content: string, color: string): unknown {
  return { tag: "text_tag", text: { tag: "plain_text", content }, color };
}

/** Builds a short Lark card for one feed item. The full briefing is one click away, so the card carries only what decides whether to open it. */
export function feedCard(feedTitle: string, item: FeedItem, isUpdate: boolean, cvss?: CvssScore): unknown {
  const [lead, ...sections] = parseArticle(item.content);
  const banner = lead?.paragraphs[0]?.match(ACTION_BANNER);
  const impact = (banner ? lead?.paragraphs[1] : lead?.paragraphs[0]) || item.summary;
  const status = item.categories.find((c) => !c.domain && !CVE_ID.test(c.label))?.label;
  const cves = cveIds(item);
  const needsAttention = status === "Needs attention";

  const tags: unknown[] = [];
  if (banner) tags.push(textTag(banner[1]!, needsAttention ? "orange" : "blue"));
  if (status) tags.push(textTag(status, needsAttention ? "red" : "neutral"));

  const lines = [md(impact)];
  const facts: string[] = [];
  if (cves.length) facts.push(cves.map((id) => `[${id}](https://www.cve.org/CVERecord?id=${id})`).join(", "));
  if (!Number.isNaN(item.publishedAt)) facts.push(new Date(item.publishedAt).toISOString().slice(0, 10));
  if (facts.length) lines.push(`<font color='grey'>${facts.join(" · ")}</font>`);

  const latest = sections.find((s) => s.heading === "Update chronology")?.items[0];
  if (latest) lines.push("", `**Latest:** ${md(latest)}`);
  const todo = sections.find((s) => s.heading === "What to do now")?.paragraphs[0];
  if (todo) lines.push(`**Do now:** ${md(todo)}`);

  const elements: unknown[] = [{ tag: "markdown", content: lines.join("\n") }];
  if (item.link) {
    elements.push({
      tag: "button",
      text: { tag: "plain_text", content: "Read the briefing" },
      type: "primary",
      behaviors: [{ type: "open_url", default_url: item.link }],
    });
  }

  const severity = cvss ? cvss.severity.charAt(0) + cvss.severity.slice(1).toLowerCase() : "";
  const score = cvss ? ` · CVSS ${[cvss.score.toFixed(1), severity].filter(Boolean).join(" ")}` : "";
  const title = `${isUpdate ? "Updated: " : ""}${item.title}${score}`;
  return {
    schema: "2.0",
    config: { width_mode: "fill", summary: { content: status ? `[${status}] ${title}` : title } },
    header: {
      template: headerTemplate(needsAttention, cvss),
      title: { tag: "plain_text", content: title },
      subtitle: { tag: "plain_text", content: [item.creator, feedTitle].filter(Boolean).join(" · ") },
      text_tag_list: tags,
    },
    body: { elements },
  };
}
