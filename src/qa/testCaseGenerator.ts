import { Priority, TestCase, TestStep, UserStory } from "../types.js";

/**
 * Deterministic, rule-based test design from acceptance criteria.
 * Techniques applied: one positive case per criterion, Gherkin parsing (Given/When/Then),
 * negative variants for "valid" inputs, required-field checks, email format checks,
 * boundary value analysis for length/number limits, and a UI smoke check.
 *
 * The MCP client (an LLM) may also pass its own test cases to `upload_test_cases` /
 * `save_test_cases`; this generator gives a solid, reproducible baseline.
 */
export function generateTestCases(story: UserStory, opts: { includeNegative?: boolean; includeBoundary?: boolean } = {}): TestCase[] {
  const includeNegative = opts.includeNegative ?? true;
  const includeBoundary = opts.includeBoundary ?? true;
  const criteria = story.acceptanceCriteria.length ? story.acceptanceCriteria : [story.title];
  const cases: Omit<TestCase, "id">[] = [];

  criteria.forEach((criterion, idx) => {
    const g = parseGherkin(criterion);
    const name = g.name || firstLine(criterion);
    const isNegativeCriterion = /\b(invalid|wrong|incorrect|not|cannot|can't|error|fail|locked|denied|reject)\b/i.test(criterion);

    // 1) Main case for the criterion
    const steps: TestStep[] = g.isGherkin ? gherkinSteps(g) : bulletSteps(criterion);
    cases.push({
      title: `Verify ${lowerFirst(stripVerify(name))}`,
      objective: `Validate acceptance criterion ${idx + 1}: ${firstLine(criterion)}`,
      preconditions: g.given.length ? g.given : ["Application is reachable", "Test user/data is available"],
      steps,
      priority: idx === 0 ? "High" : "Medium",
      type: isNegativeCriterion ? "Negative" : "Positive",
      sourceCriterion: criterion,
      tags: [`AC${idx + 1}`],
    });

    // 2) Negative counterpart: "valid X" -> "invalid X"
    if (includeNegative && !isNegativeCriterion && /\bvalid\b/i.test(criterion)) {
      const negSteps = steps.map((s) => ({
        ...s,
        action: s.action.replace(/\bvalid\b/gi, "invalid"),
        expected: s.expected ? "An error/validation message is displayed and the action is not completed" : undefined,
      }));
      if (!negSteps.some((s) => s.expected)) negSteps[negSteps.length - 1].expected = "An error/validation message is displayed";
      cases.push({
        title: `Verify error is shown for invalid data: ${lowerFirst(stripVerify(name)).replace(/\bvalid\b/gi, "invalid")}`,
        objective: `Negative variant of AC${idx + 1}`,
        preconditions: g.given.length ? g.given : ["Application is reachable"],
        steps: negSteps,
        priority: "High",
        type: "Negative",
        sourceCriterion: criterion,
        tags: [`AC${idx + 1}`, "negative"],
      });
    }

    // 3) Required fields
    const required = criterion.match(/\b([\w ]{2,30}?)\s+(?:is|are)\s+(?:required|mandatory)\b/i);
    if (includeNegative && required) {
      const field = required[1].trim().split(/\s+/).slice(-2).join(" ");
      cases.push({
        title: `Verify validation when ${field} is left empty`,
        objective: `Required-field check derived from AC${idx + 1}`,
        preconditions: ["Application is reachable"],
        steps: [
          { action: `Leave the ${field} empty` },
          { action: "Submit the form", expected: `A required-field validation message is displayed for ${field}` },
        ],
        priority: "Medium",
        type: "Negative",
        sourceCriterion: criterion,
        tags: [`AC${idx + 1}`, "validation"],
      });
    }

    // 4) Email format
    if (includeNegative && /\be-?mail\b/i.test(criterion)) {
      cases.push({
        title: "Verify validation for invalid email format",
        objective: `Email format check derived from AC${idx + 1}`,
        preconditions: ["Application is reachable"],
        steps: [
          { action: 'Enter "invalid-email@" in the email field', data: "invalid-email@" },
          { action: "Submit the form", expected: "An email format validation message is displayed" },
        ],
        priority: "Medium",
        type: "Negative",
        sourceCriterion: criterion,
        tags: [`AC${idx + 1}`, "validation"],
      });
    }

    // 5) Boundary value analysis
    if (includeBoundary) cases.push(...boundaryCases(criterion, idx));
  });

  // 6) UI smoke check of the screen under test
  cases.push({
    title: `Verify all UI elements for "${story.title}" are displayed`,
    objective: "UI smoke check of the screen(s) involved in the story",
    preconditions: ["Application is reachable"],
    steps: [
      { action: "Open the page under test", expected: "Page loads without errors" },
      { action: "Observe the page", expected: "All fields, buttons and labels from the story are visible and enabled" },
    ],
    priority: "Low",
    type: "UI",
    tags: ["ui", "smoke"],
  });

  return dedupe(cases).map((c, i) => ({ id: `TC-${String(i + 1).padStart(3, "0")}`, ...c }));
}

// ---------------- helpers ----------------

interface Gherkin {
  isGherkin: boolean;
  name: string;
  given: string[];
  when: string[];
  then: string[];
}

function parseGherkin(text: string): Gherkin {
  const g: Gherkin = { isGherkin: false, name: "", given: [], when: [], then: [] };
  let current: string[] | null = null;
  for (const raw of text.split(/\n/)) {
    const line = raw.trim();
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^Scenario(?: Outline)?\s*:\s*(.*)$/i))) g.name = m[1];
    else if ((m = line.match(/^Given\s+(.*)$/i))) (current = g.given).push(m[1]);
    else if ((m = line.match(/^When\s+(.*)$/i))) (current = g.when).push(m[1]);
    else if ((m = line.match(/^Then\s+(.*)$/i))) (current = g.then).push(m[1]);
    else if ((m = line.match(/^(?:And|But)\s+(.*)$/i)) && current) current.push(m[1]);
    // also support inline "Given ..., when ..., then ..."
  }
  if (!g.when.length && !g.then.length) {
    const inline = text.match(/given\s+(.+?),?\s+when\s+(.+?),?\s+then\s+(.+)/i);
    if (inline) {
      g.given = [inline[1].trim()];
      g.when = splitAnd(inline[2]);
      g.then = [inline[3].trim().replace(/\.$/, "")];
    }
  }
  g.isGherkin = g.when.length > 0 || g.then.length > 0;
  return g;
}

function splitAnd(s: string): string[] {
  return s
    .split(/\s*,\s*(?:and\s+)?|\s+and\s+(?=(?:clicks?|enters?|selects?|submits?|types?|presses?|opens?|navigates?|taps?)\b)/i)
    .map((x) => x.trim())
    .filter(Boolean);
}

function gherkinSteps(g: Gherkin): TestStep[] {
  const steps: TestStep[] = [];
  // a "Given I am on the X page" precondition becomes the first navigation step
  const nav = g.given.find((x) => /\b(on|at|open|navigate)\b.*\b(page|screen|site|application|app)\b/i.test(x));
  if (nav) steps.push({ action: "Navigate to " + nav.replace(/^(?:(?:the user|user|i)\s+(?:is|am)\s+)?(?:on|at)\s+/i, "").replace(/^(?:opens?|navigates? to)\s+/i, "") });
  for (const w of g.when) steps.push({ action: capitalize(stripActor(w)), data: quoted(w) });
  const expected = g.then.map((t) => capitalize(t.replace(/^the user\b/i, "User"))).join("; ");
  if (steps.length === 0) steps.push({ action: "Perform the scenario action" });
  steps[steps.length - 1].expected = expected || undefined;
  return steps;
}

function bulletSteps(criterion: string): TestStep[] {
  const text = firstLine(criterion).replace(/\.$/, "");
  const m = text.match(/^(?:the\s+)?(?:user|users|customer|admin|i)\s+(?:should be able to|can|must be able to|is able to)\s+(.+)$/i);
  if (m) {
    return [
      { action: "Navigate to the page under test" },
      { action: capitalize(m[1]), data: quoted(m[1]), expected: `The user is able to ${m[1]}` },
    ];
  }
  return [
    { action: "Navigate to the page under test" },
    { action: "Perform the action described in the criterion" },
    { action: "Observe the result", expected: capitalize(text) },
  ];
}

function boundaryCases(criterion: string, idx: number): Omit<TestCase, "id">[] {
  const out: Omit<TestCase, "id">[] = [];
  const field = (criterion.match(/\b([\w]+)\s+(?:must|should|can|has to)\b/i)?.[1] ?? "field").toLowerCase();
  const mk = (len: number, valid: boolean, label: string): Omit<TestCase, "id"> => ({
    title: `Verify ${field} with ${label} (${len} characters) is ${valid ? "accepted" : "rejected"}`,
    objective: `Boundary value analysis derived from AC${idx + 1}`,
    preconditions: ["Application is reachable"],
    steps: [
      { action: `Enter a ${len}-character value in the ${field} field`, data: "x".repeat(Math.max(len, 0)) },
      { action: "Submit the form", expected: valid ? `The ${field} value is accepted` : `A length validation message is displayed for ${field}` },
    ],
    priority: "Medium",
    type: "Boundary",
    sourceCriterion: criterion,
    tags: [`AC${idx + 1}`, "boundary"],
  });

  const between = criterion.match(/between\s+(\d+)\s+(?:and|-|to)\s+(\d+)\s+char/i);
  const min = criterion.match(/(?:at least|minimum(?: of)?|min\.?)\s+(\d+)\s+char/i);
  const max = criterion.match(/(?:at most|maximum(?: of)?|max\.?|up to|no more than)\s+(\d+)\s+char/i);
  const lo = between ? +between[1] : min ? +min[1] : undefined;
  const hi = between ? +between[2] : max ? +max[1] : undefined;
  if (lo !== undefined) out.push(mk(lo - 1, false, "length below minimum"), mk(lo, true, "minimum length"));
  if (hi !== undefined) out.push(mk(hi, true, "maximum length"), mk(hi + 1, false, "length above maximum"));
  return out;
}

const firstLine = (s: string) => s.split("\n")[0].replace(/^Scenario(?: Outline)?\s*:\s*/i, "").trim();
const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const lowerFirst = (s: string) => (s && !/^[A-Z]{2}/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);
const stripVerify = (s: string) => s.replace(/^verify\s+(that\s+)?/i, "").replace(/\.$/, "");
const stripActor = (s: string) => s.replace(/^(the user|user|i|they|he|she)\s+/i, "");
const quoted = (s: string) => s.match(/["“']([^"”']+)["”']/)?.[1];

function dedupe<T extends { title: string }>(arr: T[]): T[] {
  const seen = new Set<string>();
  return arr.filter((c) => {
    const k = c.title.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function testCasesToMarkdown(story: UserStory, cases: TestCase[]): string {
  const out = [`# Test Cases — ${story.id}: ${story.title}`, ""];
  for (const tc of cases) {
    out.push(`## ${tc.id}: ${tc.title}`, `**Priority:** ${tc.priority} · **Type:** ${tc.type}${tc.externalId ? ` · **Tracker:** [${tc.externalId}](${tc.externalUrl})` : ""}`);
    if (tc.preconditions?.length) out.push("", "**Preconditions:**", ...tc.preconditions.map((p) => `- ${p}`));
    out.push("", "| # | Action | Data | Expected |", "|---|---|---|---|");
    tc.steps.forEach((s, i) => out.push(`| ${i + 1} | ${s.action} | ${s.data ?? ""} | ${s.expected ?? ""} |`));
    out.push("");
  }
  return out.join("\n");
}

export const PRIORITIES: Priority[] = ["High", "Medium", "Low"];
