import { decodeEntities } from "./rss.ts";

export interface ArticleSection {
  heading: string;
  paragraphs: string[];
  items: string[];
}

function inner(html: string, tag: string): string[] {
  return [...html.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => m[1]!);
}

function textOf(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

function section(heading: string, html: string): ArticleSection {
  return {
    heading,
    paragraphs: inner(html, "p").map(textOf).filter(Boolean),
    items: inner(html, "li").map(textOf).filter(Boolean),
  };
}

/** Splits an HTML article on its h2 headings. The first section is the text before the first h2 and has an empty heading. */
export function parseArticle(html: string): ArticleSection[] {
  const [lead = "", ...rest] = html.split(/<h2(?:\s[^>]*)?>/);
  return [
    section("", lead),
    ...rest.map((s) => {
      const [h = "", body = ""] = s.split("</h2>");
      return section(textOf(h), body);
    }),
  ];
}
