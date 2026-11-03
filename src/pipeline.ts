import path from "node:path";
import { config } from "./config.js";
import { readStory, uploadTestCases } from "./integrations/tracker.js";
import { commitAndPush, GitProvider } from "./git/gitService.js";
import { detectLocators, DetectOptions } from "./qa/locatorDetector.js";
import { generateProject } from "./qa/projectGenerator.js";
import { generateTestCases, testCasesToMarkdown } from "./qa/testCaseGenerator.js";
import { generateAllureReport } from "./runner/allure.js";
import { runTests } from "./runner/testRunner.js";
import { PageLocators, TestCase, Tracker, UserStory } from "./types.js";
import { loadJson, saveJson, storyDir, writeFile } from "./utils/workspace.js";

export interface PipelineParams {
  storyId: string;
  tracker?: Tracker;
  trackerProject?: string;
  pages: DetectOptions["pages"];
  baseUrl?: string;
  login?: DetectOptions["login"];
  projectDir?: string;
  projectName?: string;
  uploadTestCases?: boolean;
  testPlanId?: string;
  testSuiteId?: string;
  git?: { provider: GitProvider; repoName: string; branch?: string; owner?: string; azureProject?: string } | null;
  runTests?: boolean;
  generateReport?: boolean;
  allowPendingSteps?: boolean;
  credentials?: { username: string; password: string };
}

export interface StepLog {
  step: string;
  status: "done" | "skipped" | "failed";
  detail: string;
}

export function defaultProjectDir(storyId: string): string {
  return path.join(storyDir(storyId), "automation");
}

export async function runPipeline(p: PipelineParams, progress?: (msg: string, i: number, total: number) => void): Promise<StepLog[]> {
  const log: StepLog[] = [];
  const total = 8;
  const tick = (i: number, m: string) => progress?.(m, i, total);
  const projectDir = p.projectDir ?? defaultProjectDir(p.storyId);

  // 1. Read user story
  tick(1, "Reading user story");
  const story: UserStory = await readStory(p.storyId, p.tracker, p.trackerProject);
  saveJson(story.id, "story.json", story);
  log.push({ step: "1. User story", status: "done", detail: `${story.id}: ${story.title} (${story.acceptanceCriteria.length} acceptance criteria)` });

  // 2-3. Generate test cases
  tick(2, "Generating test cases");
  let cases: TestCase[] = generateTestCases(story);
  saveJson(story.id, "testcases.json", cases);
  log.push({ step: "2. Test cases", status: "done", detail: `${cases.length} test cases generated` });

  // 4. Upload
  tick(3, "Uploading test cases");
  if (p.uploadTestCases === false) log.push({ step: "3. Upload", status: "skipped", detail: "uploadTestCases=false" });
  else {
    try {
      cases = await uploadTestCases(story, cases, { project: p.trackerProject, testPlanId: p.testPlanId, testSuiteId: p.testSuiteId });
      saveJson(story.id, "testcases.json", cases);
      log.push({ step: "3. Upload", status: "done", detail: cases.map((c) => c.externalId).join(", ") });
    } catch (e) {
      log.push({ step: "3. Upload", status: "failed", detail: (e as Error).message });
    }
  }
  writeFile(path.join(storyDir(story.id), "testcases.md"), testCasesToMarkdown(story, cases));

  // 5. Locators
  tick(4, "Detecting locators");
  const pages: PageLocators[] = await detectLocators({ pages: p.pages, login: p.login });
  saveJson(story.id, "locators.json", pages);
  log.push({ step: "4. Locators", status: "done", detail: pages.map((x) => `${x.pageName}: ${x.locators.length}`).join(", ") });

  // 6. Generate POM project
  tick(5, "Generating automation project");
  const baseUrl = p.baseUrl || config.defaultBaseUrl || new URL(p.pages[0].url).origin;
  const gen = generateProject({
    projectDir,
    projectName: p.projectName ?? `${story.id}-ui-automation`,
    baseUrl,
    story,
    testCases: cases,
    pages,
    credentials: p.credentials ?? (p.login ? { username: p.login.username, password: p.login.password } : undefined),
  });
  const pendingCount = gen.pendingSteps.reduce((n, x) => n + x.items.length, 0);
  log.push({ step: "5. Code (POM)", status: "done", detail: `${gen.files.length} files in ${projectDir}; ${pendingCount} step(s) need manual implementation` });

  // 7. Commit & push
  tick(6, "Committing and pushing");
  if (!p.git) log.push({ step: "6. Git push", status: "skipped", detail: "no git target given" });
  else {
    try {
      const r = await commitAndPush({ projectDir, ...p.git, commitMessage: `${story.id}: add generated UI automation (${cases.length} test cases)` });
      log.push({ step: "6. Git push", status: "done", detail: `${r.webUrl} @ ${r.branch} (${r.commit.slice(0, 8)})` });
    } catch (e) {
      log.push({ step: "6. Git push", status: "failed", detail: (e as Error).message });
    }
  }

  // 8. Run
  tick(7, "Running tests");
  if (p.runTests === false) log.push({ step: "7. Run", status: "skipped", detail: "runTests=false" });
  else {
    const r = await runTests({ projectDir, baseUrl, allowPendingSteps: p.allowPendingSteps });
    const s = r.summary;
    log.push({
      step: "7. Run",
      status: s ? "done" : "failed",
      detail: s ? `total ${s.total} | passed ${s.passed} | failed ${s.failed} | skipped ${s.skipped} | flaky ${s.flaky}` : r.outputTail,
    });
  }

  // 9. Report
  tick(8, "Generating Allure report");
  if (p.generateReport === false || p.runTests === false) log.push({ step: "8. Report", status: "skipped", detail: "" });
  else {
    try {
      const r = await generateAllureReport({ projectDir, reportName: `${story.id} — ${story.title}` });
      log.push({ step: "8. Report", status: "done", detail: r.indexHtml });
    } catch (e) {
      log.push({ step: "8. Report", status: "failed", detail: (e as Error).message });
    }
  }
  return log;
}

export function loadStoryOrThrow(storyId: string): UserStory {
  const s = loadJson<UserStory>(storyId, "story.json");
  if (!s) throw new Error(`Story ${storyId} has not been read yet. Call read_user_story first.`);
  return s;
}
