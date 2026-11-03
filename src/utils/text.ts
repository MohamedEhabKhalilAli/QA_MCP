/** Convert simple HTML (Azure DevOps rich text) to readable plain text, keeping list items on their own lines. */
export function htmlToText(html: string | undefined | null): string {
  if (!html) return "";
  return html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "\n- ")
    .replace(/<\/\s*(p|div|li|h[1-6]|tr|ul|ol)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Atlassian Document Format -> plain text */
export function adfToText(node: any): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  const children = (node.content ?? []).map(adfToText);
  switch (node.type) {
    case "text":
      return node.text ?? "";
    case "hardBreak":
      return "\n";
    case "paragraph":
    case "heading":
      return children.join("") + "\n";
    case "listItem":
      return "- " + children.join("").trim() + "\n";
    case "bulletList":
    case "orderedList":
      return children.join("") + "\n";
    case "tableRow":
      return children.map((c: string) => c.trim()).join(" | ") + "\n";
    case "mention":
      return node.attrs?.text ?? "";
    default:
      return children.join("");
  }
}

/** Plain text -> minimal ADF document (paragraph per line). */
export function textToAdf(text: string): any {
  const lines = text.split(/\r?\n/);
  return {
    type: "doc",
    version: 1,
    content: lines.map((l) => ({
      type: "paragraph",
      content: l ? [{ type: "text", text: l }] : [],
    })),
  };
}

/**
 * Extract acceptance criteria from free text. Understands:
 *  - an "Acceptance Criteria" heading followed by bullets / numbered lines
 *  - Gherkin "Scenario:" blocks (Given/When/Then kept together)
 *  - "AC1: ..." style lines
 */
/**
 * Jira tables with Given / When / Then columns, e.g.
 *   # | Scenario | Given | When | Then
 *   1 | Default pagination | The user opens X | The page loads | 50 rows are shown
 * become Gherkin scenarios. Returns null if the text has no such table.
 */
function tableToGherkin(text: string): string[] | null {
  const lines = text.split("\n");
  const hi = lines.findIndex((l) => l.includes("|") && /\bgiven\b/i.test(l) && /\bthen\b/i.test(l) && !/\bgiven\s+\w+\s+\w+/i.test(l.replace(/\|/g, " | ")));
  if (hi < 0) return null;
  const cells = (l: string) => l.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
  const head = cells(lines[hi]).map((h) => h.toLowerCase());
  const col = (re: RegExp) => head.findIndex((h) => re.test(h));
  const [cName, cGiven, cWhen, cThen] = [col(/scenario|name|title|description/), col(/^given/), col(/^when/), col(/^then/)];
  if (cThen < 0) return null;
  const out: string[] = [];
  for (const l of lines.slice(hi + 1)) {
    if (!l.includes("|")) continue;
    const c = cells(l);
    if (c.length < head.length - 1 || c.every((x) => /^[-:\s]*$/.test(x))) continue;
    const name = (cName >= 0 && c[cName]) || `Scenario ${out.length + 1}`;
    const parts = [`Scenario: ${name}`];
    if (cGiven >= 0 && c[cGiven]) parts.push(`Given ${c[cGiven]}`);
    if (cWhen >= 0 && c[cWhen]) parts.push(`When ${c[cWhen]}`);
    if (c[cThen]) parts.push(`Then ${c[cThen]}`);
    out.push(parts.join("\n"));
  }
  return out.length ? out : null;
}

export function extractAcceptanceCriteria(text: string): string[] {
  if (!text) return [];
  const fromTable = tableToGherkin(text.replace(/\r/g, ""));
  if (fromTable) return fromTable;
  const t = text
    .replace(/\r/g, "")
    // Jira table header row
    .replace(/^\s*\|?\s*(scenario|name|title|#|ac)\s*\|\s*(description|steps|criteria|details)[^\n]*$/gim, "")
    // "Scenario name | Given ..." table rows -> Gherkin
    .replace(/^\s*\|?\s*([^|\n]+?)\s*\|\s*(Given\b)/gim, "Scenario: $1\n$2")
    .replace(/\s*\|\s*$/gm, "");

  // Gherkin scenarios
  const scenarioBlocks = t.split(/\n(?=\s*Scenario(?: Outline)?\s*:)/i).filter((b) => /^\s*Scenario/i.test(b));
  if (scenarioBlocks.length) return scenarioBlocks.map((b) => b.trim());

  let section = t;
  const m = t.match(/acceptance\s+criteria\s*:?\s*\n([\s\S]*)/i);
  if (m) section = m[1];

  const lines = section
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const items: string[] = [];
  for (const line of lines) {
    if (/^(definition of done|notes?|out of scope)\b/i.test(line)) break;
    const bullet = line.match(/^(?:[-*•]|\d+[.)]|AC\s*\d+\s*[:.)-])\s*(.+)$/i);
    if (bullet) {
      if (bullet[1].trim().replace(/[\W_]/g, "")) items.push(bullet[1].trim());
    }
    else if (/^(given|when|then|and|but)\b/i.test(line) && items.length) items[items.length - 1] += "\n" + line;
    else if (m) items.push(line);
  }
  return items;
}

export function toPascalCase(s: string): string {
  return s
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("");
}

export function toCamelCase(s: string): string {
  const p = toPascalCase(s);
  return p ? p[0].toLowerCase() + p.slice(1) : p;
}

export function toKebab(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

/** Escape a value for use inside a single-quoted TS string literal. */
export function q(s: string): string {
  return "'" + s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\r?\n/g, " ") + "'";
}

/** Token overlap similarity (0..1) used to match test-step text with locator names. */
export function similarity(a: string, b: string): number {
  const tok = (s: string) =>
    new Set(
      s
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 1 && !STOP.has(w)),
    );
  const A = tok(a);
  const B = tok(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / Math.min(A.size, B.size);
}
const STOP = new Set(["the", "a", "an", "on", "in", "to", "of", "and", "field", "button", "input", "link", "user", "into", "with"]);
