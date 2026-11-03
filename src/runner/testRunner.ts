import fs from "node:fs";
import path from "node:path";
import { run, tail } from "../utils/exec.js";

export interface RunOptions {
  projectDir: string;
  installDependencies?: boolean;
  installBrowsers?: boolean;
  grep?: string;
  headed?: boolean;
  baseUrl?: string;
  workers?: number;
  allowPendingSteps?: boolean;
  timeoutMs?: number;
}

export interface TestSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  flaky: number;
  durationMs: number;
  failures: { title: string; error: string }[];
}

export interface RunResult {
  exitCode: number;
  summary?: TestSummary;
  install?: string;
  outputTail: string;
}

export async function runTests(o: RunOptions): Promise<RunResult> {
  const cwd = o.projectDir;
  if (!fs.existsSync(path.join(cwd, "package.json"))) throw new Error(`No package.json in ${cwd}. Generate the project first.`);
  let install = "";

  const needInstall = o.installDependencies ?? !fs.existsSync(path.join(cwd, "node_modules"));
  if (needInstall) {
    const r = await run("npm", ["install", "--no-audit", "--no-fund"], { cwd, timeoutMs: 10 * 60_000 });
    install += `npm install -> exit ${r.code}\n${tail(r.stderr, 1500)}`;
    if (r.code !== 0) return { exitCode: r.code, install, outputTail: tail(r.stdout + r.stderr) };
  }
  if (o.installBrowsers ?? needInstall) {
    const r = await run("npx", ["playwright", "install", "chromium"], { cwd, timeoutMs: 10 * 60_000 });
    install += `\nplaywright install chromium -> exit ${r.code}`;
  }

  // clean previous results so the report reflects this run only
  fs.rmSync(path.join(cwd, "allure-results"), { recursive: true, force: true });

  const args = ["playwright", "test"];
  if (o.grep) args.push("--grep", JSON.stringify(o.grep));
  if (o.headed) args.push("--headed");
  if (o.workers) args.push("--workers", String(o.workers));
  const env: Record<string, string> = {};
  if (o.baseUrl) env.BASE_URL = o.baseUrl;
  if (o.allowPendingSteps) env.ALLOW_PENDING_STEPS = "true";
  if (o.headed) env.HEADLESS = "false";

  const r = await run("npx", args, { cwd, env, timeoutMs: o.timeoutMs ?? 30 * 60_000 });
  return { exitCode: r.code, summary: readSummary(cwd), install: install || undefined, outputTail: tail(r.stdout + "\n" + r.stderr, 4000) };
}

export function readSummary(projectDir: string): TestSummary | undefined {
  const file = path.join(projectDir, "test-results", "results.json");
  if (!fs.existsSync(file)) return undefined;
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  const failures: TestSummary["failures"] = [];
  const walk = (suite: any, prefix: string) => {
    for (const s of suite.suites ?? []) walk(s, prefix ? `${prefix} › ${s.title}` : s.title);
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        const last = t.results?.[t.results.length - 1];
        if (t.status === "unexpected" && last) {
          failures.push({ title: `${prefix} › ${spec.title}`, error: String(last.error?.message ?? "").replace(/\u001b\[[0-9;]*m/g, "").slice(0, 600) });
        }
      }
    }
  };
  for (const s of json.suites ?? []) walk(s, s.title);
  const st = json.stats ?? {};
  return {
    total: (st.expected ?? 0) + (st.unexpected ?? 0) + (st.skipped ?? 0) + (st.flaky ?? 0),
    passed: st.expected ?? 0,
    failed: st.unexpected ?? 0,
    skipped: st.skipped ?? 0,
    flaky: st.flaky ?? 0,
    durationMs: Math.round(st.duration ?? 0),
    failures,
  };
}
