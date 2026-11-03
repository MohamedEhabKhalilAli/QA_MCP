import { chromium, Locator, Page } from "playwright";
import { LocatorEntry, PageLocators } from "../types.js";
import { toCamelCase, toPascalCase } from "../utils/text.js";

export interface DetectOptions {
  pages: { name?: string; url: string }[];
  headless?: boolean;
  waitMs?: number;
  /** Path to a Playwright storageState JSON for authenticated pages */
  storageStatePath?: string;
  /** Optional login performed once before crawling */
  login?: { url: string; username: string; password: string; usernameSelector?: string; passwordSelector?: string; submitSelector?: string };
  maxElementsPerPage?: number;
  /** Key/values written to localStorage before any page script runs (e.g. tenant / country / language selection) */
  localStorage?: Record<string, string>;
}

interface RawEl {
  idx: number;
  tag: string;
  type: string;
  role: string;
  id: string;
  name: string;
  testIdAttr: string;
  testId: string;
  ariaLabel: string;
  placeholder: string;
  label: string;
  text: string;
  title: string;
  alt: string;
  href: string;
  cssPath: string;
}

const MARK = "data-qa-mcp-idx";

export async function detectLocators(opts: DetectOptions): Promise<PageLocators[]> {
  const browser = await chromium.launch({ headless: opts.headless ?? true });
  try {
    const context = await browser.newContext(opts.storageStatePath ? { storageState: opts.storageStatePath } : {});
    if (opts.localStorage && Object.keys(opts.localStorage).length) {
      await context.addInitScript((items: Record<string, string>) => {
        try {
          for (const [k, v] of Object.entries(items)) if (window.localStorage.getItem(k) === null) window.localStorage.setItem(k, v);
        } catch {
          /* storage not available on this origin */
        }
      }, opts.localStorage);
    }
    const page = await context.newPage();

    // Pages that ARE the login page are crawled before signing in (otherwise they redirect to the dashboard).
    const samePath = (a: string, b: string) => {
      try {
        return new URL(a).pathname.replace(/\/+$/, "") === new URL(b).pathname.replace(/\/+$/, "");
      } catch {
        return false;
      }
    };
    const ordered = opts.login
      ? [...opts.pages.filter((p) => samePath(p.url, opts.login!.url)), ...opts.pages.filter((p) => !samePath(p.url, opts.login!.url))]
      : opts.pages;
    let loggedIn = false;

    const results: PageLocators[] = [];
    const usedNames = new Set<string>();
    for (const target of ordered) {
      if (opts.login && !loggedIn && !samePath(target.url, opts.login.url)) {
        await performLogin(page, opts.login);
        loggedIn = true;
      }
      await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
      if (opts.waitMs) await page.waitForTimeout(opts.waitMs);

      let pageName = toPascalCase(target.name || guessPageName(target.url, await page.title()));
      if (!pageName.endsWith("Page")) pageName += "Page";
      while (usedNames.has(pageName)) pageName = pageName.replace(/Page$/, "") + "2Page";
      usedNames.add(pageName);

      const raw = await collect(page, opts.maxElementsPerPage ?? 80);
      const locators: LocatorEntry[] = [];
      const usedKeys = new Set<string>();
      for (const el of raw) {
        const entry = await buildEntry(page, el, usedKeys);
        if (entry) locators.push(entry);
      }
      await page.evaluate((m) => document.querySelectorAll(`[${m}]`).forEach((e) => e.removeAttribute(m)), MARK);
      results.push({ pageName, url: page.url(), title: await page.title(), locators });
    }
    if (opts.login && !loggedIn) await performLogin(page, opts.login);
    // keep the caller's page order
    results.sort((a, b) => ordered.indexOf(ordered.find((o) => o.name && a.pageName.startsWith(o.name))!) - ordered.indexOf(ordered.find((o) => o.name && b.pageName.startsWith(o.name))!));
    return results;
  } finally {
    await browser.close();
  }
}

async function performLogin(page: Page, l: NonNullable<DetectOptions["login"]>) {
  await page.goto(l.url, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
  const user = l.usernameSelector
    ? page.locator(l.usernameSelector)
    : page
        .locator('input[type="email"], input[type="tel"], input[name*="user" i], input[id*="user" i], input[name*="email" i], input[name*="phone" i], input[name*="mobile" i], input[type="text"]')
        .first();
  const pass = l.passwordSelector ? page.locator(l.passwordSelector) : page.locator('input[type="password"]').first();
  await user.fill(l.username);
  await pass.fill(l.password);
  const submit = l.submitSelector
    ? page.locator(l.submitSelector)
    : page.locator('button[type="submit"], input[type="submit"], button:has-text("Log in"), button:has-text("Login"), button:has-text("Sign in")').first();
  const before = page.url();
  await submit.click();
  // SPA logins navigate asynchronously: wait for the URL to change, then for the app to settle
  await page.waitForURL((u) => u.toString() !== before, { timeout: 20_000 }).catch(() => undefined);
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
  if (samePathOf(page.url(), l.url)) {
    const err = await page.locator('[role="alert"], [class*="error" i]:visible, [class*="toast" i]:visible').first().innerText({ timeout: 2000 }).catch(() => "");
    throw new Error(`[qa-mcp] Login did not succeed - still on ${page.url()}${err ? `. Message on page: "${err.trim().slice(0, 200)}"` : ""}`);
  }
}

function samePathOf(a: string, b: string): boolean {
  try {
    return new URL(a).pathname.replace(/\/+$/, "") === new URL(b).pathname.replace(/\/+$/, "");
  } catch {
    return false;
  }
}

function guessPageName(url: string, title: string): string {
  try {
    const seg = new URL(url).pathname.split("/").filter(Boolean).pop();
    if (seg) return seg.replace(/\.\w+$/, "");
  } catch {
    /* ignore */
  }
  return title.split(/[|\-–]/)[0].trim() || "Home";
}

/** Runs in the browser: find visible interactive + assertion-worthy elements and describe them. */
async function collect(page: Page, max: number): Promise<RawEl[]> {
  return page.evaluate(
    ({ mark, max }) => {
      const SELECTOR = [
        "input:not([type=hidden])",
        "button",
        "a[href]",
        "select",
        "textarea",
        "[role=button]",
        "[role=link]",
        "[role=checkbox]",
        "[role=radio]",
        "[role=tab]",
        "[role=menuitem]",
        "[role=switch]",
        "[role=combobox]",
        "[contenteditable=true]",
        "h1",
        "h2",
        "[role=alert]",
        "[class*=error i]:not(:empty)",
        "[class*=flash i]:not(:empty)",
      ].join(",");
      const visible = (el: Element) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
      };
      const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
      const labelFor = (el: Element): string => {
        const anyEl = el as HTMLInputElement;
        if (anyEl.labels && anyEl.labels.length) return clean(anyEl.labels[0].textContent);
        const by = el.getAttribute("aria-labelledby");
        if (by) return clean(by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" "));
        const parentLabel = el.closest("label");
        if (parentLabel) return clean(parentLabel.textContent);
        return "";
      };
      const implicitRole = (el: Element): string => {
        const explicit = el.getAttribute("role");
        if (explicit) return explicit;
        const tag = el.tagName.toLowerCase();
        const type = (el.getAttribute("type") ?? "text").toLowerCase();
        if (tag === "button") return "button";
        if (tag === "a") return "link";
        if (tag === "select") return el.hasAttribute("multiple") ? "listbox" : "combobox";
        if (tag === "textarea") return "textbox";
        if (/^h[1-6]$/.test(tag)) return "heading";
        if (tag === "input") {
          if (["button", "submit", "reset", "image"].includes(type)) return "button";
          if (type === "checkbox") return "checkbox";
          if (type === "radio") return "radio";
          if (type === "range") return "slider";
          if (["number"].includes(type)) return "spinbutton";
          if (["search"].includes(type)) return "searchbox";
          if (["text", "email", "tel", "url", ""].includes(type)) return "textbox";
          return "";
        }
        return "";
      };
      const cssPath = (el: Element): string => {
        const parts: string[] = [];
        let cur: Element | null = el;
        while (cur && cur.nodeType === 1 && parts.length < 5) {
          let part = cur.tagName.toLowerCase();
          if (cur.id && !/\d{3,}|[:.]/.test(cur.id)) {
            parts.unshift(`#${CSS.escape(cur.id)}`);
            break;
          }
          const parent: Element | null = cur.parentElement;
          if (parent) {
            const same = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName);
            if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
          }
          parts.unshift(part);
          cur = parent;
        }
        return parts.join(" > ");
      };

      const els = Array.from(document.querySelectorAll(SELECTOR)).filter(visible);
      // drop error containers nested in another collected element, and duplicates
      const out: any[] = [];
      const seen = new Set<Element>();
      for (const el of els) {
        if (seen.has(el)) continue;
        seen.add(el);
        if (out.length >= max) break;
        const idx = out.length;
        el.setAttribute(mark, String(idx));
        const testIdAttr = ["data-testid", "data-test-id", "data-test", "data-qa", "data-cy"].find((a) => el.hasAttribute(a)) ?? "";
        out.push({
          idx,
          tag: el.tagName.toLowerCase(),
          type: (el.getAttribute("type") ?? "").toLowerCase(),
          role: implicitRole(el),
          id: el.id ?? "",
          name: el.getAttribute("name") ?? "",
          testIdAttr,
          testId: testIdAttr ? el.getAttribute(testIdAttr) ?? "" : "",
          ariaLabel: clean(el.getAttribute("aria-label")),
          placeholder: clean(el.getAttribute("placeholder")),
          label: labelFor(el).slice(0, 60),
          text: clean((el as HTMLElement).innerText || (el as HTMLInputElement).value || "").slice(0, 80),
          title: clean(el.getAttribute("title")),
          alt: clean(el.querySelector("img")?.getAttribute("alt")),
          href: el.getAttribute("href") ?? "",
          cssPath: cssPath(el),
        });
      }
      return out;
    },
    { mark: MARK, max },
  );
}

function elementType(el: RawEl): string {
  if (el.role === "heading") return "heading";
  if (el.role === "alert" || /error|flash/i.test(el.cssPath) || (el.tag === "div" && !el.role)) return "message";
  if (el.tag === "select" || el.role === "combobox" || el.role === "listbox") return "select";
  if (el.tag === "textarea") return "textarea";
  if (el.role === "checkbox" || el.role === "switch") return "checkbox";
  if (el.role === "radio") return "radio";
  if (el.role === "button") return "button";
  if (el.role === "link") return "link";
  if (el.tag === "input" || el.role === "textbox" || el.role === "searchbox" || el.role === "spinbutton") return "input";
  return "other";
}

const SUFFIX: Record<string, string> = {
  input: "Input",
  textarea: "Textarea",
  select: "Select",
  checkbox: "Checkbox",
  radio: "Radio",
  button: "Button",
  link: "Link",
  heading: "Heading",
  message: "Message",
  other: "Element",
};

const isDynamicId = (id: string) => !id || /\d{4,}|[a-f0-9]{8,}|^(ember|react|mui|radix|headlessui)|^:r|[:]/i.test(id);
const lit = (s: string) => JSON.stringify(s).replace(/^"|"$/g, "").replace(/'/g, "\\'");

async function buildEntry(page: Page, el: RawEl, usedKeys: Set<string>): Promise<LocatorEntry | null> {
  const type = elementType(el);
  const accName = el.label || el.ariaLabel || (["button", "link", "heading", "message"].includes(type) ? el.text : "") || el.title || el.alt || el.placeholder;
  const human = (el.label || el.ariaLabel || el.placeholder || el.text || el.title || el.alt || el.name || el.id || el.testId || el.tag).slice(0, 40);

  // candidates in priority order: [strategy, expression, factory]
  const cands: [LocatorEntry["strategy"], string, () => Locator][] = [];
  if (el.testId) {
    if (el.testIdAttr === "data-testid")
      cands.push(["testId", `page.getByTestId('${lit(el.testId)}')`, () => page.getByTestId(el.testId)]);
    else cands.push(["testId", `page.locator('[${el.testIdAttr}="${lit(el.testId)}"]')`, () => page.locator(`[${el.testIdAttr}="${el.testId}"]`)]);
  }
  if (el.role && accName && type !== "message")
    cands.push([
      "role",
      `page.getByRole('${el.role}', { name: '${lit(accName)}', exact: true })`,
      () => page.getByRole(el.role as any, { name: accName, exact: true }),
    ]);
  if (el.label && ["input", "textarea", "select", "checkbox", "radio"].includes(type))
    cands.push(["label", `page.getByLabel('${lit(el.label)}', { exact: true })`, () => page.getByLabel(el.label, { exact: true })]);
  if (el.placeholder) cands.push(["placeholder", `page.getByPlaceholder('${lit(el.placeholder)}', { exact: true })`, () => page.getByPlaceholder(el.placeholder, { exact: true })]);
  if (el.id && !isDynamicId(el.id)) cands.push(["id", `page.locator('#${lit(el.id)}')`, () => page.locator(`#${cssEscape(el.id)}`)]);
  if (el.name) cands.push(["name", `page.locator('${el.tag}[name="${lit(el.name)}"]')`, () => page.locator(`${el.tag}[name="${el.name}"]`)]);
  if (el.text && el.text.length <= 50) cands.push(["text", `page.getByText('${lit(el.text)}', { exact: true })`, () => page.getByText(el.text, { exact: true })]);
  cands.push(["css", `page.locator('${lit(el.cssPath)}')`, () => page.locator(el.cssPath)]);

  let chosen: (typeof cands)[number] | undefined;
  const alternatives: string[] = [];
  for (const c of cands) {
    try {
      const loc = c[2]();
      if ((await loc.count()) !== 1) continue;
      const idx = await loc.getAttribute(MARK, { timeout: 1000 });
      if (idx !== String(el.idx)) continue;
      if (!chosen) chosen = c;
      else alternatives.push(c[1]);
    } catch {
      /* candidate not usable */
    }
  }
  if (!chosen) return null;

  let key = toCamelCase(human.replace(/[^a-zA-Z0-9 ]/g, " ")) || el.tag;
  if (/^\d/.test(key)) key = "el" + key;
  key = key.slice(0, 30) + SUFFIX[type];
  let k = key;
  let n = 2;
  while (usedKeys.has(k)) k = `${key}${n++}`;
  usedKeys.add(k);

  return {
    key: k,
    description: `${human} ${type}`.trim(),
    elementType: type,
    strategy: chosen[0],
    playwright: chosen[1],
    css: el.id && !isDynamicId(el.id) ? `#${el.id}` : el.cssPath,
    unique: true,
    alternatives: alternatives.slice(0, 3),
  };
}

function cssEscape(id: string): string {
  return id.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
}
