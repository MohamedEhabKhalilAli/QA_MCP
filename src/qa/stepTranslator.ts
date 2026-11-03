import { LocatorEntry, PageLocators, TestStep } from "../types.js";
import { q, similarity, toCamelCase } from "../utils/text.js";
import { methodNameFor } from "./naming.js";

export interface TranslatedStep {
  title: string;
  code: string[]; // lines inside test.step
  pending: string[]; // parts that could not be automated
  usedPages: Set<string>; // fixture names used
}

interface Ctx {
  pages: PageLocators[];
  entryPage: string; // fixture name of the first page
}

const fixture = (p: PageLocators) => toCamelCase(p.pageName);

const INPUT_TYPES = ["input", "textarea"];
const CLICK_TYPES = ["button", "link", "other", "checkbox", "radio"];

function findLocator(ctx: Ctx, target: string, types: string[], minScore = 0.5): { page: PageLocators; loc: LocatorEntry } | undefined {
  let best: { page: PageLocators; loc: LocatorEntry; score: number } | undefined;
  for (const page of ctx.pages) {
    for (const loc of page.locators) {
      if (!types.includes(loc.elementType)) continue;
      const score = Math.max(similarity(target, loc.description), similarity(target, loc.key));
      if (score >= minScore && (!best || score > best.score)) best = { page, loc, score };
    }
  }
  return best;
}

function findErrorLocator(ctx: Ctx): { page: PageLocators; loc: LocatorEntry } | undefined {
  for (const page of ctx.pages)
    for (const loc of page.locators)
      if (loc.elementType === "message" && /error|alert|invalid|danger|warn|fail/i.test(`${loc.key} ${loc.description} ${loc.css ?? ""}`)) return { page, loc };
  return undefined;
}

/** Build code that logs in through the detected login form (used for "user is logged in" preconditions). */
export function loginCode(ctx: Ctx, variant: "valid" | "invalid" = "valid"): { code: string[]; pageFx: string; passwordKey: string } | undefined {
  for (const page of ctx.pages) {
    const user = page.locators.find((l) => INPUT_TYPES.includes(l.elementType) && /user|email|login/i.test(l.key));
    const pass = page.locators.find((l) => INPUT_TYPES.includes(l.elementType) && /pass/i.test(l.key));
    const btn = page.locators.find((l) => l.elementType === "button" && /log ?in|sign ?in|submit/i.test(l.description));
    if (user && pass && btn) {
      const f = fixture(page);
      return {
        pageFx: f,
        passwordKey: pass.key,
        code: [
          `await ${f}.open();`,
          `await ${f}.${methodNameFor(user)}(testData.${f}.${user.key}.${variant});`,
          `await ${f}.${methodNameFor(pass)}(testData.${f}.${pass.key}.${variant});`,
          `await ${f}.${methodNameFor(btn)}();`,
        ],
      };
    }
  }
  return undefined;
}

function findPage(ctx: Ctx, text: string): PageLocators | undefined {
  let best: { p: PageLocators; s: number } | undefined;
  for (const p of ctx.pages) {
    const s = Math.max(similarity(text, p.pageName.replace(/Page$/, "")), p.title ? similarity(text, p.title) : 0);
    if (s >= 0.5 && (!best || s > best.s)) best = { p, s };
  }
  return best?.p;
}

const quotedValues = (s: string) => Array.from(s.matchAll(/["“']([^"”']*)["”']/g)).map((m) => m[1]);
const stripQuotes = (s: string) => s.replace(/["“']([^"”']*)["”']/g, " ");

/** Translate one action clause into code. Returns null if not understood. */
function translateAction(ctx: Ctx, clause: string, data: string | undefined, out: TranslatedStep): boolean {
  const c = clause.trim();
  const lower = c.toLowerCase();

  // URL navigation
  const url = c.match(/https?:\/\/\S+/)?.[0];
  if (/\b(navigate|open|go to|goes to|visit|launch|access|is on|am on|lands? on)\b/.test(lower)) {
    if (url) {
      out.code.push(`await page.goto(${q(url.replace(/[.,;]$/, ""))});`);
      out.usedPages.add("page");
      return true;
    }
    const p = findPage(ctx, stripQuotes(c)) ?? ctx.pages.find((x) => fixture(x) === ctx.entryPage);
    if (p) {
      out.code.push(`await ${fixture(p)}.open();`);
      out.usedPages.add(fixture(p));
      return true;
    }
  }

  // "log in with valid/invalid credentials" -> drive the detected login form
  if (/\b(log|logs|sign|signs)\s?in\b/.test(lower) && !/\b(page|button|link)\b/.test(lower)) {
    const l = loginCode(ctx, /\b(invalid|wrong|incorrect|bad)\b/.test(lower) ? "invalid" : "valid");
    if (l) {
      out.code.push(...l.code);
      out.usedPages.add(l.pageFx);
      out.usedPages.add("testData");
      return true;
    }
  }

  // leave empty / clear
  if (/\b(leave|leaves|clear|clears)\b/.test(lower) && /\b(empty|blank)\b|\bclear/.test(lower)) {
    const hit = findLocator(ctx, stripQuotes(c), INPUT_TYPES, 0.34);
    if (hit) {
      out.code.push(`await ${fixture(hit.page)}.${methodNameFor(hit.loc)}('');`);
      out.usedPages.add(fixture(hit.page));
      return true;
    }
  }

  // fill / type
  if (/\b(enter|enters|type|types|fill|fills|input|inputs|provide|provides|write|writes|set|sets)\b/.test(lower)) {
    const values = quotedValues(c);
    const targetText = stripQuotes(c).replace(/\b(enter|enters|type|types|fill|fills|input|inputs|provide|provides|write|writes|in|into|the|field|a|an|value)\b/gi, " ");
    // "enters valid username and password" -> two inputs
    const parts = values.length <= 1 ? targetText.split(/\s+and\s+|,/).filter((p) => p.trim()) : [targetText];
    let any = false;
    parts.forEach((part, i) => {
      const hit = findLocator(ctx, part, INPUT_TYPES, 0.34);
      if (!hit) return;
      const pageFx = fixture(hit.page);
      let valueExpr: string;
      if (values[i] !== undefined) valueExpr = q(values[i]);
      else if (data && parts.length === 1) valueExpr = q(data);
      else if (/\b(invalid|wrong|incorrect|bad)\b/i.test(c)) valueExpr = `testData.${pageFx}.${hit.loc.key}.invalid`;
      else valueExpr = `testData.${pageFx}.${hit.loc.key}.valid`;
      out.code.push(`await ${pageFx}.${methodNameFor(hit.loc)}(${valueExpr});`);
      out.usedPages.add(pageFx);
      if (valueExpr.startsWith("testData")) out.usedPages.add("testData");
      any = true;
    });
    if (any) return true;
  }

  // select from dropdown
  if (/\b(select|selects|choose|chooses|pick|picks)\b/.test(lower)) {
    const values = quotedValues(c);
    const hit = findLocator(ctx, stripQuotes(c), ["select"], 0.34);
    if (hit && values[0] !== undefined) {
      out.code.push(`await ${fixture(hit.page)}.${methodNameFor(hit.loc)}(${q(values[0])});`);
      out.usedPages.add(fixture(hit.page));
      return true;
    }
  }

  // check / uncheck
  if (/\b(check|checks|tick|ticks|uncheck|unchecks|toggle|toggles)\b/.test(lower)) {
    const hit = findLocator(ctx, stripQuotes(c), ["checkbox", "radio"], 0.34);
    if (hit) {
      const fn = methodNameFor(hit.loc);
      out.code.push(`await ${fixture(hit.page)}.${fn}(${/\bun/.test(lower) ? "false" : "true"});`);
      out.usedPages.add(fixture(hit.page));
      return true;
    }
  }

  // click / submit
  if (/\b(click|clicks|press|presses|tap|taps|submit|submits|hit|hits|select|selects|choose|chooses)\b/.test(lower)) {
    const target = stripQuotes(c).replace(/\b(click|clicks|press|presses|tap|taps|on|the|hit|hits)\b/gi, " ");
    const values = quotedValues(c);
    let hit = findLocator(ctx, values[0] ?? target, CLICK_TYPES, 0.34) ?? findLocator(ctx, target, CLICK_TYPES, 0.34);
    if (!hit && /\bsubmit/.test(lower)) {
      // generic submit -> best button whose name hints submit/login/save/continue
      hit = findLocator(ctx, "submit login sign save continue send register next", ["button"], 0.01);
    }
    if (hit) {
      out.code.push(`await ${fixture(hit.page)}.${methodNameFor(hit.loc)}();`);
      out.usedPages.add(fixture(hit.page));
      return true;
    }
    if (values[0]) {
      out.code.push(`await page.getByText(${q(values[0])}, { exact: true }).click();`);
      out.usedPages.add("page");
      return true;
    }
  }

  return false;
}

/** Translate an expected-result clause into assertions. */
function translateExpected(ctx: Ctx, clause: string, out: TranslatedStep): boolean {
  const c = clause.trim();
  const lower = c.toLowerCase();
  const values = quotedValues(c);

  // redirected / navigated to X page
  const nav = c.match(/\b(?:redirected|navigated|taken|lands?|landed|directed)\s+(?:to|on)\s+(?:the\s+)?(.+?)(?:\s+page|\s+screen|$)/i);
  if (nav) {
    const p = findPage(ctx, nav[1]);
    if (p) {
      out.code.push(`await ${fixture(p)}.expectLoaded();`);
      out.usedPages.add(fixture(p));
      return true;
    }
    out.code.push(`await expect(page).toHaveURL(new RegExp(${q(nav[1].trim().split(/\s+/)[0])}, 'i'));`);
    out.usedPages.add("page");
    return true;
  }

  // "able to log in" -> the login form is gone
  if (/\b(able to|successfully|is)\s+(log(ged)?|sign(ed)?)\s?in\b/.test(lower) && !/\bnot\b/.test(lower)) {
    const l = loginCode(ctx);
    if (l) {
      out.code.push(`await expect(${l.pageFx}.${l.passwordKey}).toBeHidden();`);
      out.usedPages.add(l.pageFx);
      return true;
    }
  }

  // quoted text should be visible
  if (values.length && /\b(see|seen|display|displayed|shows?|shown|visible|appears?|contains?|message|title|text)\b/.test(lower)) {
    for (const v of values) out.code.push(`await expect(page.getByText(${q(v)}).first()).toBeVisible();`);
    out.usedPages.add("page");
    return true;
  }

  // element state
  const stateMatch = lower.match(/\b(disabled|enabled|checked|hidden|not (?:be )?(?:displayed|visible))\b/);
  const hitEl = findLocator(ctx, stripQuotes(c), ["input", "textarea", "select", "checkbox", "radio", "button", "link", "heading", "message", "other"], 0.5);
  if (hitEl && (stateMatch || /\b(displayed|visible|shown|present|appears?)\b/.test(lower))) {
    const pageFx = fixture(hitEl.page);
    const locExpr = `${pageFx}.${hitEl.loc.key}`;
    const state = stateMatch?.[1] ?? "";
    const matcher = state === "disabled" ? "toBeDisabled()" : state === "enabled" ? "toBeEnabled()" : state === "checked" ? "toBeChecked()" : state ? "toBeHidden()" : "toBeVisible()";
    out.code.push(`await expect(${locExpr}).${matcher};`);
    out.usedPages.add(pageFx);
    return true;
  }

  // generic error / validation message
  if (/\b(error|validation|invalid|warning|required)\b/.test(lower)) {
    const msg = findErrorLocator(ctx);
    if (msg) {
      out.code.push(`await expect(${fixture(msg.page)}.${msg.loc.key}).toBeVisible();`);
      out.usedPages.add(fixture(msg.page));
    } else {
      out.code.push(`await expectAnyErrorMessage(page);`);
      out.usedPages.add("page");
      out.usedPages.add("helpers");
    }
    return true;
  }

  // page loads / all elements visible
  if (/\b(page loads|loads without errors|is displayed|are visible|all fields)\b/.test(lower)) {
    const p = ctx.pages.find((x) => fixture(x) === ctx.entryPage)!;
    out.code.push(`await ${fixture(p)}.expectAllElementsVisible();`);
    out.usedPages.add(fixture(p));
    return true;
  }

  return false;
}

export function translateStep(ctx: Ctx, step: TestStep, index: number): TranslatedStep {
  const out: TranslatedStep = { title: `${index + 1}. ${step.action}`, code: [], pending: [], usedPages: new Set() };

  const generic = /^(perform the (action|scenario)|observe the (result|page))/i.test(step.action);
  const isOpenUnderTest = /page under test/i.test(step.action);
  if (isOpenUnderTest) {
    out.code.push(`await ${ctx.entryPage}.open();`);
    out.usedPages.add(ctx.entryPage);
  } else if (!generic && !translateAction(ctx, step.action, step.data, out)) {
    out.pending.push(`Action: ${step.action}`);
  }

  if (step.expected) {
    for (const clause of step.expected.split(/\s*;\s*/)) {
      if (!translateExpected(ctx, clause, out)) out.pending.push(`Expected: ${clause}`);
    }
  }
  return out;
}

export type { Ctx as TranslateContext };
