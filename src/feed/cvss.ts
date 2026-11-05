import { log } from "../utils/logger.ts";

export interface CvssScore {
  score: number;
  severity: string;
}

type CvssMetric = { baseScore?: unknown; baseSeverity?: unknown };
type Metrics = Partial<Record<string, CvssMetric>>[];
interface CveRecord {
  containers?: { cna?: { metrics?: Metrics }; adp?: { metrics?: Metrics }[] };
}

const NEWEST_FIRST = ["cvssV4_0", "cvssV3_1", "cvssV3_0", "cvssV2_0"];

function newestScore(metrics: Metrics): CvssScore | undefined {
  for (const version of NEWEST_FIRST) {
    for (const m of metrics) {
      const cvss = m[version];
      if (typeof cvss?.baseScore === "number") {
        return { score: cvss.baseScore, severity: typeof cvss.baseSeverity === "string" ? cvss.baseSeverity : "" };
      }
    }
  }
  return undefined;
}

// CVE Services record API: https://cveawg.mitre.org/api-docs/
async function cveScore(id: string): Promise<CvssScore | undefined> {
  const res = await fetch(`https://cveawg.mitre.org/api/cve/${encodeURIComponent(id)}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const record = (await res.json()) as CveRecord;
  const adp = (record.containers?.adp ?? []).flatMap((a) => a.metrics ?? []);
  return newestScore(record.containers?.cna?.metrics ?? []) ?? newestScore(adp);
}

/** Highest CVSS base score across the CVE records, preferring the CNA score over an ADP one. A record that fails to load counts as unscored. */
export async function highestCvss(cveIds: string[]): Promise<CvssScore | undefined> {
  const scores = await Promise.all(
    cveIds.map((id) =>
      cveScore(id).catch((e) => {
        log.warn("cve record lookup failed", { cve: id, error: String(e) });
        return undefined;
      }),
    ),
  );
  return scores.filter((s) => s !== undefined).sort((a, b) => b.score - a.score)[0];
}
