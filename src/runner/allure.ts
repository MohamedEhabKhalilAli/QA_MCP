import fs from "node:fs";
import path from "node:path";
import { run, tail } from "../utils/exec.js";

export interface AllureOptions {
  projectDir: string;
  reportName?: string;
  open?: boolean;
}

export interface AllureResult {
  reportDir: string;
  indexHtml: string;
  resultFiles: number;
  log: string;
}

export async function generateAllureReport(o: AllureOptions): Promise<AllureResult> {
  const resultsDir = path.join(o.projectDir, "allure-results");
  if (!fs.existsSync(resultsDir) || fs.readdirSync(resultsDir).length === 0) {
    throw new Error("allure-results is empty. Run the tests first (run_tests).");
  }
  const reportDir = path.join(o.projectDir, "allure-report");
  // Allure 3 (pure Node — no Java needed). Uses allurerc.mjs from the project if present.
  const args = ["allure", "generate", "./allure-results", "-o", "./allure-report", "--clean"];
  if (o.reportName) args.push("--name", JSON.stringify(o.reportName));
  const r = await run("npx", args, { cwd: o.projectDir, timeoutMs: 5 * 60_000 });
  if (r.code !== 0) throw new Error(`Allure generate failed (exit ${r.code}):\n${tail(r.stdout + r.stderr, 2500)}`);

  if (o.open) {
    // fire and forget: serve + open in default browser
    void run("npx", ["allure", "open", "./allure-report"], { cwd: o.projectDir });
  }
  return {
    reportDir,
    indexHtml: path.join(reportDir, "index.html"),
    resultFiles: fs.readdirSync(resultsDir).length,
    log: tail(r.stdout, 800),
  };
}
