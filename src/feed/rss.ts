export interface FeedCategory {
  label: string;
  domain?: string;
}

export interface FeedItem {
  guid: string;
  title: string;
  link: string;
  publishedAt: number;
  creator: string;
  summary: string;
  /** Raw HTML of `content:encoded`, empty when the feed has none. */
  content: string;
  categories: FeedCategory[];
}

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] !== "#") return NAMED_ENTITIES[ref.toLowerCase()] ?? whole;
    const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
    return String.fromCodePoint(code);
  });
}

function decode(raw: string): string {
  const cdata = raw.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return cdata ? cdata[1]!.trim() : decodeEntities(raw).trim();
}

function matches(xml: string, name: string): RegExpExecArray[] {
  return [...xml.matchAll(new RegExp(`<${name}(\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "g"))];
}

function element(xml: string, name: string): string {
  const m = matches(xml, name)[0];
  return m ? decode(m[2]!) : "";
}

/** Parses the `<item>` elements of an RSS 2.0 document. An item with no guid falls back to its link. */
export function parseRss(xml: string): { title: string; items: FeedItem[] } {
  const channelTitle = element(xml.split("<item>")[0] ?? "", "title");
  const items = matches(xml, "item").flatMap(([, , block = ""]): FeedItem[] => {
    const link = element(block, "link");
    const guid = element(block, "guid") || link;
    if (!guid) return [];
    return [
      {
        guid,
        title: element(block, "title"),
        link,
        publishedAt: Date.parse(element(block, "pubDate")),
        creator: element(block, "dc:creator"),
        summary: element(block, "description"),
        content: element(block, "content:encoded"),
        categories: matches(block, "category").map(([, attrs = "", label = ""]) => ({
          label: decode(label),
          domain: attrs.match(/domain="([^"]*)"/)?.[1],
        })),
      },
    ];
  });
  return { title: channelTitle, items };
}
