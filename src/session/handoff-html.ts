
const NON_BROWSER_UA =
  /curl|wget|libwww|python|requests|httpx|aiohttp|node|bun|deno|undici|axios|got\/|go-http-client|okhttp|java\/|scrapy|httpie|postman|insomnia|claude|anthropic|openai|gpt|copilot|cursor|codex|langchain|\bbot\b|crawler|spider|slurp/i;

export function prefersHtml(req: Request): boolean {
  const params = new URL(req.url).searchParams;
  const format = params.get("format") ?? (params.has("raw") ? "md" : "");
  if (/^(md|raw|markdown|text)$/i.test(format)) return false;
  if (/^html$/i.test(format)) return true;

  const ua = req.headers.get("user-agent") ?? "";
  if (NON_BROWSER_UA.test(ua)) return false;
  if (!/text\/html/i.test(req.headers.get("accept") ?? "")) return false;
  return /Mozilla\//.test(ua);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const BARE_URL = /https?:\/\/[^\s<>"'`)\]]+[^\s<>"'`)\].,;:!?]/g;
const MD_LINK = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|\/[^\s)]*)\)/g;
const MD_IMAGE = /!\[([^\]\n]*)\]\((https?:\/\/[^\s)]+|\/[^\s)]*)\)/g;

function renderInline(escaped: string): string {
  const stashed: string[] = [];
  const stash = (html: string): string => `\u0000${stashed.push(html) - 1}\u0000`;

  let out = escaped
    .replace(/`([^`\n]+)`/g, (_m, body: string) => stash(`<code>${body}</code>`))
    .replace(MD_IMAGE, (_m, alt: string, src: string) => stash(`<img src="${src}" alt="${alt}" loading="lazy">`))
    .replace(MD_LINK, (_m, label: string, href: string) => stash(`<a href="${href}">${label}</a>`))
    .replace(BARE_URL, (url) => stash(`<a href="${url}">${url}</a>`))
    .replace(/(\*\*|__)([^\n]+?)\1/g, "<strong>$2</strong>")
    .replace(/~~([^\n]+?)~~/g, "<del>$1</del>")
    .replace(/(^|[\s(])([_*])([^\n]+?)\2(?=$|[\s).,;:!?])/g, "$1<em>$3</em>");

  while (out.includes("\u0000")) {
    out = out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => stashed[Number(i)] ?? "");
  }
  return out;
}

function inline(raw: string): string {
  return renderInline(escapeHtml(raw));
}

interface ListLevel {
  tag: "ul" | "ol";
  indent: number;
}

function renderBlocks(md: string): { html: string; mermaid: boolean } {
  const lines = md.split("\n");
  const out: string[] = [];
  const open: ListLevel[] = [];
  let para: string[] = [];
  let quote: string[] = [];
  let mermaid = false;

  const closeLists = (toIndent = -1): void => {
    while (open.length && open[open.length - 1]!.indent > toIndent) {
      out.push(`</li></${open.pop()!.tag}>`);
    }
  };
  const flushPara = (): void => {
    if (!para.length) return;
    out.push(`<p>${inline(para.join(" "))}</p>`);
    para = [];
  };
  const flushQuote = (): void => {
    if (!quote.length) return;
    out.push(`<blockquote>${inline(quote.join(" "))}</blockquote>`);
    quote = [];
  };
  const flushText = (): void => {
    flushPara();
    flushQuote();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    const fence = line.match(/^\s*(```|~~~)(.*)$/);
    if (fence) {
      flushText();
      closeLists();
      const marker = fence[1]!;
      const lang = fence[2]!.trim().toLowerCase();
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i]!.trimStart().startsWith(marker); i++) body.push(lines[i]!);
      const code = escapeHtml(body.join("\n"));
      if (lang === "mermaid") {
        mermaid = true;
        out.push(`<pre class="mermaid">${code}</pre>`);
      } else {
        out.push(`<pre><code>${code}</code></pre>`);
      }
      continue;
    }

    if (!line.trim()) {
      flushText();
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushText();
      closeLists();
      const level = heading[1]!.length;
      out.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
      continue;
    }

    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
      flushText();
      closeLists();
      out.push("<hr>");
      continue;
    }

    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? "")) {
      flushText();
      closeLists();
      const cells = (row: string): string[] =>
        row
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((c) => c.trim());
      const head = cells(line).map((c) => `<th>${inline(c)}</th>`);
      const rows: string[] = [];
      for (i += 2; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i] ?? ""); i++) {
        const tds = cells(lines[i]!)
          .map((c) => `<td>${inline(c)}</td>`)
          .join("");
        rows.push(`<tr>${tds}</tr>`);
      }
      i--;
      out.push(`<table><thead><tr>${head.join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>`);
      continue;
    }

    const bullet = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (bullet) {
      flushText();
      const indent = bullet[1]!.length;
      const tag: "ul" | "ol" = /\d/.test(bullet[2]!) ? "ol" : "ul";
      const top = open[open.length - 1];
      if (!top || indent > top.indent) {
        out.push(`<${tag}><li>`);
        open.push({ tag, indent });
      } else {
        closeLists(indent);
        const same = open[open.length - 1];
        if (same && same.indent === indent && same.tag === tag) out.push("</li><li>");
        else {
          closeLists(indent - 1);
          out.push(`<${tag}><li>`);
          open.push({ tag, indent });
        }
      }
      const task = bullet[3]!.match(/^\[([ xX])\]\s+(.*)$/);
      if (task) {
        const checked = task[1] !== " " ? " checked" : "";
        out.push(`<label><input type="checkbox" disabled${checked}> ${inline(task[2]!)}</label>`);
      } else {
        out.push(inline(bullet[3]!));
      }
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      flushPara();
      if (!/^\s/.test(line)) closeLists();
      quote.push(line.replace(/^\s*>\s?/, ""));
      continue;
    }

    if (open.length && /^\s+\S/.test(line)) {
      out.push(`<div class="cont">${inline(line.trim())}</div>`);
      continue;
    }

    flushQuote();
    closeLists();
    para.push(line.trim());
  }

  flushText();
  closeLists();
  return { html: out.join("\n"), mermaid };
}

const CSS = `
:root { color-scheme: light dark; --fg: #1c1f24; --muted: #626b78; --bg: #fbfbfa; --card: #fff;
        --line: #e3e5e8; --accent: #1f6feb; --code-bg: #f0f1f3; }
@media (prefers-color-scheme: dark) {
  :root { --fg: #dfe3e8; --muted: #9aa4b2; --bg: #15181d; --card: #1b1f26;
          --line: #2b313a; --accent: #6cb0ff; --code-bg: #22272f; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg);
       font: 16px/1.62 ui-sans-serif, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
main { max-width: 52rem; margin: 0 auto; padding: 2.5rem 1.25rem 6rem; }
h1, h2, h3, h4 { line-height: 1.28; margin: 2rem 0 .6rem; font-weight: 650; }
h1 { font-size: 1.72rem; margin-top: 0; }
h2 { font-size: 1.24rem; padding-bottom: .3rem; border-bottom: 1px solid var(--line); }
h3 { font-size: 1.06rem; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
h4 { font-size: 1rem; }
p, li { overflow-wrap: anywhere; }
ul, ol { padding-left: 1.35rem; margin: .5rem 0; }
li { margin: .28rem 0; }
li > ul, li > ol { margin: .28rem 0; }
a { color: var(--accent); }
a:hover { text-decoration-thickness: 2px; }
code { font: .875em/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
       background: var(--code-bg); padding: .1em .34em; border-radius: 4px; }
pre { background: var(--card); border: 1px solid var(--line); border-radius: 8px;
      padding: .8rem 1rem; overflow-x: auto; }
pre code { background: none; padding: 0; font-size: .84rem; }
.cont { margin: .1rem 0 .4rem; font-size: .93em; }
.cont code { display: inline-block; max-width: 100%; }
blockquote { margin: .8rem 0; padding: .1rem 0 .1rem 1rem; border-left: 3px solid var(--line);
             color: var(--muted); }
table { border-collapse: collapse; margin: .8rem 0; font-size: .93rem; display: block; overflow-x: auto; }
th, td { border: 1px solid var(--line); padding: .35rem .6rem; text-align: left; }
hr { border: 0; border-top: 1px solid var(--line); margin: 1.6rem 0; }
img { max-width: 100%; border-radius: 6px; }
del { color: var(--muted); }
label { display: inline-flex; gap: .45rem; align-items: baseline; }
li:has(> label) { list-style: none; margin-left: -1.1rem; }
pre.mermaid { text-align: center; font: .84rem/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
pre.mermaid[data-processed] { background: none; border: 0; padding: .4rem 0; }
.raw { margin-top: 2.5rem; padding-top: .9rem; border-top: 1px solid var(--line);
       font-size: .85rem; color: var(--muted); }
`;

const MERMAID_SCRIPT = `<script type="module">
import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
mermaid.initialize({
  startOnLoad: true,
  securityLevel: "strict",
  theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "default",
});
</script>`;

export function renderHandoffHtml(md: string, title: string): string {
  const { html, mermaid } = renderBlocks(md);
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head><body><main>
${html}
<p class="raw">Add <code>?raw=1</code> to this URL for the plain markdown an agent should read.</p>
</main>${mermaid ? MERMAID_SCRIPT : ""}</body></html>`;
}
