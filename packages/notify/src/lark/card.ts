import type {
  Alert,
  RCAReport,
  RemediationProposal,
  ResourceFinding,
  ValidatedClaim,
} from "@opsremedy/core/types";
import type { CardElement, CardEnvelope } from "../types.ts";
import { colorFor } from "./colors.ts";
import { capList, jsonByteSize, truncate } from "./truncate.ts";

/** Hard Lark cap is 30KB; build to 25KB so JSON quote-escaping has headroom. */
export const CARD_TARGET_BYTES = 25_000;
const TITLE_MAX = 100;
const ROOT_CAUSE_MAX = 1500;
const CAUSAL_CHAIN_MAX = 8;
const CLAIMS_MAX = 8;
const UNVERIFIED_MAX = 5;
const FINDINGS_MAX = 8;
const COMMAND_MAX = 200;

/**
 * Map of evidence source key (e.g. "gcp_logs", "jaeger_traces") to a deep-link
 * URL the user can click to inspect the underlying data. Built by the CLI from
 * resolved settings + alert labels; passed through to the card unchanged.
 */
export type EvidenceLinks = Partial<Record<string, string>>;

interface BuildOpts {
  /** Optional URL for an "Open alert" action button. */
  alertUrl?: string;
  /** Optional per-source links rendered inline in claim source lists. */
  evidenceLinks?: EvidenceLinks;
}

/**
 * Build a Lark message-card v1 envelope (with `markdown` elements) from an
 * RCA report. Pure function — testable via golden snapshots. Truncation
 * runs in waves until the JSON is below CARD_TARGET_BYTES.
 */
export function buildRcaCard(report: RCAReport, alert: Alert, opts: BuildOpts = {}): CardEnvelope {
  const elements = assembleElements(report, alert, opts, /* level */ 0);
  let card = envelope(report, alert, elements);

  // Progressive trim: each level drops or shortens more sections. Five levels
  // total; if we still exceed the target after the last we accept the result.
  for (let level = 1; level <= 5 && jsonByteSize(card) > CARD_TARGET_BYTES; level++) {
    card = envelope(report, alert, assembleElements(report, alert, opts, level));
  }
  return card;
}

function envelope(report: RCAReport, alert: Alert, elements: CardElement[]): CardEnvelope {
  return {
    config: { wide_screen_mode: true },
    header: {
      template: colorFor(report.root_cause_category),
      title: {
        tag: "plain_text",
        content: truncate(`[${alert.severity}] ${alert.alert_name}`, TITLE_MAX),
      },
    },
    elements,
  };
}

function assembleElements(report: RCAReport, alert: Alert, opts: BuildOpts, level: number): CardElement[] {
  const els: CardElement[] = [];

  els.push({ tag: "markdown", content: metaLine(report) });
  els.push({ tag: "hr" });

  els.push({
    tag: "markdown",
    content: rootCauseSection(report.root_cause, level),
  });
  els.push({ tag: "hr" });

  els.push({
    tag: "markdown",
    content: causalChainSection(report.causal_chain, level),
  });

  // Findings ranks above claims so the "what's broken right now" table is
  // visible first when a structured analyzer found anything.
  if (report.findings && report.findings.length > 0 && level < 3) {
    els.push({ tag: "hr" });
    els.push({ tag: "markdown", content: findingsSection(report.findings, level) });
  }

  if (report.validated_claims.length > 0) {
    els.push({ tag: "hr" });
    els.push({
      tag: "markdown",
      content: validatedClaimsSection(report.validated_claims, level, opts.evidenceLinks ?? {}),
    });
  }

  // Drop unverified claims at level >= 1.
  if (level < 1 && report.unverified_claims.length > 0) {
    els.push({ tag: "hr" });
    els.push({
      tag: "markdown",
      content: unverifiedClaimsSection(report.unverified_claims),
    });
  }

  if (report.remediation.length > 0) {
    els.push({ tag: "hr" });
    els.push({
      tag: "markdown",
      content: remediationSection(report.remediation, level),
    });
  }

  if (opts.alertUrl) {
    els.push({ tag: "hr" });
    els.push({
      tag: "action",
      actions: [
        {
          tag: "button",
          text: { tag: "plain_text", content: "Open alert" },
          type: "default",
          url: opts.alertUrl,
        },
      ],
    });
  }

  // Last-resort: replace body with a placeholder. Reachable only at level 5
  // when even the trimmed sections won't fit.
  if (level >= 5) {
    return [
      {
        tag: "markdown",
        content:
          `**[${alert.severity}] ${alert.alert_name}**\n\n` +
          `Report too large to render as a card. ` +
          `Category: ${report.root_cause_category} · ` +
          `Confidence: ${pct(report.confidence)}\n\n` +
          `See JSON output for details.`,
      },
    ];
  }
  return els;
}

// ---------- section builders ----------

function metaLine(r: RCAReport): string {
  return [
    `**Category:** ${r.root_cause_category}`,
    `**Confidence:** ${pct(r.confidence)}`,
    `**Duration:** ${r.duration_ms}ms`,
  ].join(" · ");
}

function rootCauseSection(text: string, level: number): string {
  // Level 4: aggressively shorten root cause to 600 chars.
  const max = level >= 4 ? 600 : ROOT_CAUSE_MAX;
  return `**Root cause**\n\n${truncate(text || "_(none)_", max)}`;
}

function causalChainSection(chain: string[], level: number): string {
  // Level 3+: cap to 4 entries; otherwise 8.
  const max = level >= 3 ? 4 : CAUSAL_CHAIN_MAX;
  const { kept, overflow } = capList(chain, max);
  const lines = kept.map((step, i) => `${i + 1}. ${truncate(step, 300)}`);
  if (overflow > 0) lines.push(`_(+${overflow} more)_`);
  if (kept.length === 0) lines.push("_(none)_");
  return ["**Causal chain**", "", ...lines].join("\n");
}

function validatedClaimsSection(claims: ValidatedClaim[], level: number, links: EvidenceLinks): string {
  const { kept, overflow } = capList(claims, CLAIMS_MAX);
  const lines = kept.map((c) => {
    const claim = truncate(c.claim, 240);
    // Level 2+: drop the per-claim source list to save bytes.
    if (level >= 2) return `- ${claim}`;
    const sources = c.evidence_sources.length === 0 ? "—" : renderSources(c.evidence_sources, links);
    return `- ${claim} _(sources: ${sources})_`;
  });
  if (overflow > 0) lines.push(`_(+${overflow} more)_`);
  return ["**Validated claims**", "", ...lines].join("\n");
}

/**
 * Render a list of source keys, linkifying any whose key has a URL in
 * `links`. Lark `markdown` element supports `[label](url)` inline.
 *
 * Lark/CommonMark link syntax treats `)` as the end of the URL, so any
 * URL containing `(` or `)` (e.g. PromQL expressions like `sum(rate(...))`
 * URL-encoded into `g0.expr`) corrupts the link and Lark silently drops
 * or mangles the entire markdown block. Percent-encode parens defensively.
 */
function renderSources(sources: string[], links: EvidenceLinks): string {
  return sources
    .map((s) => {
      const url = links[s];
      return url ? `[${s}](${escapeMarkdownUrl(url)})` : s;
    })
    .join(", ");
}

/** Escape characters CommonMark treats as link-syntax terminators. */
function escapeMarkdownUrl(url: string): string {
  return url.replace(/\(/g, "%28").replace(/\)/g, "%29");
}

function findingsSection(findings: ResourceFinding[], level: number): string {
  // Level 2: cap to 4 entries; level 0-1: 8.
  const max = level >= 2 ? 4 : FINDINGS_MAX;
  const { kept, overflow } = capList(findings, max);
  const lines = kept.map((f) => {
    const head = f.parent ? `**${f.parent}**` : `**${f.kind}/${f.name}**`;
    const ns = f.namespace ? ` _(ns: ${f.namespace})_` : "";
    return `- ${head}${ns} — ${truncate(f.text, 240)}`;
  });
  if (overflow > 0) lines.push(`_(+${overflow} more)_`);
  return ["**Findings**", "", ...lines].join("\n");
}

function unverifiedClaimsSection(claims: string[]): string {
  const { kept, overflow } = capList(claims, UNVERIFIED_MAX);
  const lines = kept.map((c) => `- ${truncate(c, 240)}`);
  if (overflow > 0) lines.push(`_(+${overflow} more)_`);
  return ["**Unverified claims**", "", ...lines].join("\n");
}

function remediationSection(remediation: RemediationProposal[], level: number): string {
  const lines: string[] = ["**Remediation (dry-run)**", ""];
  for (const r of remediation) {
    const desc = truncate(r.description, 240);
    lines.push(`- ${desc} _(risk: ${r.risk})_`);
    // Level 4+: drop commands entirely.
    if (level < 4 && r.command) {
      lines.push(`  \`${truncate(r.command, COMMAND_MAX)}\``);
    }
  }
  return lines.join("\n");
}

// ---------- formatting helpers ----------

function pct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}
