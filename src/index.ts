#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { config } from "./config.js";
import { commitAndPush } from "./git/gitService.js";
import { readStory, uploadTestCases } from "./integrations/tracker.js";
import { defaultProjectDir, loadStoryOrThrow, runPipeline } from "./pipeline.js";
import { detectLocators } from "./qa/locatorDetector.js";
import { generateProject } from "./qa/projectGenerator.js";
import { generateTestCases, testCasesToMarkdown } from "./qa/testCaseGenerator.js";
import { generateAllureReport } from "./runner/allure.js";
import { runTests } from "./runner/testRunner.js";
import { PageLocators, TestCase, UserStory } from "./types.js";
import { extractAcceptanceCriteria } from "./utils/text.js";
import { loadJson, requireJson, saveJson, storyDir, writeFile } from "./utils/workspace.js";

const server = new McpServer(
  { name: "qa-mcp", version: "1.1.0" },
  {
    instructions:
      "QA automation workflow server. Typical order: read_user_story → generate_test_cases (or save_test_cases with your own) → " +
      "upload_test_cases → detect_locators → generate_automation_project → git_commit_push → run_tests → generate_allure_report. " +
      "run_qa_pipeline does everything in one call. All artifacts are kept per story in the workspace, so later tools only need storyId.",
  },
);

// ---------------- helpers ----------------
type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (summary: string, data?: unknown): ToolResult => ({
  content: [{ type: "text", text: data === undefined ? summary : `${summary}\n\n${JSON.stringify(data, null, 2)}` }],
});
const fail = (e: unknown): ToolResult => ({
  content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
  isError: true,
});
function safe<A>(fn: (args: A, extra: any) => Promise<ToolResult>) {
  return async (args: A, extra: any) => {
    try {
      return await fn(args, extra);
    } catch (e) {
      console.error("[qa-mcp]", e);
      return fail(e);
    }
  };
}
const projectDirFor = (storyId?: string, projectDir?: string) => {
  if (projectDir) return path.resolve(projectDir);
  if (!storyId) throw new Error("Provide storyId or projectDir.");
  return defaultProjectDir(storyId);
};

const trackerEnum = z.enum(["jira", "azure"]);
const stepSchema = z.object({ action: z.string(), expected: z.string().optional(), data: z.string().optional() });
const testCaseSchema = z.object({
  id: z.string().optional(),
  title: z.string(),
  objective: z.string().optional(),
  preconditions: z.array(z.string()).optional(),
  steps: z.array(stepSchema).min(1),
  priority: z.enum(["High", "Medium", "Low"]).default("Medium"),
  type: z.enum(["Positive", "Negative", "Boundary", "UI"]).default("Positive"),
  tags: z.array(z.string()).optional(),
  sourceCriterion: z.string().optional(),
});
const pagesSchema = z
  .array(z.object({ url: z.string().url(), name: z.string().optional().describe("Page object name, e.g. Login → LoginPage") }))
  .min(1);
const loginSchema = z
  .object({
    url: z.string().url(),
    username: z.string(),
    password: z.string(),
    usernameSelector: z.string().optional(),
    passwordSelector: z.string().optional(),
    submitSelector: z.string().optional(),
  })
  .optional()
  .describe("Log in once before crawling pages behind authentication");

// ================= 1. Read user story =================
server.registerTool(
  "read_user_story",
  {
    title: "Read User Story",
    description:
      "Read a user story from Jira (key like ABC-123) or Azure DevOps (numeric work item id). Extracts title, description and acceptance criteria and stores them in the workspace. " +
      "If you have no tracker access you can pass manualStory instead.",
    inputSchema: {
      storyId: z.string().describe("Jira issue key (e.g. QA-12) or Azure DevOps work item id (e.g. 4521)"),
      tracker: trackerEnum.optional().describe("Auto-detected from storyId if omitted"),
      project: z.string().optional().describe("Azure DevOps project (defaults to AZDO_PROJECT)"),
      manualStory: z
        .object({ title: z.string(), description: z.string().default(""), acceptanceCriteria: z.array(z.string()).optional() })
        .optional(),
    },
  },
  safe(async ({ storyId, tracker, project, manualStory }) => {
    let story: UserStory;
    if (manualStory) {
      story = {
        tracker: tracker ?? config.defaultTracker,
        id: storyId,
        title: manualStory.title,
        description: manualStory.description,
        acceptanceCriteria: manualStory.acceptanceCriteria?.length
          ? manualStory.acceptanceCriteria
          : extractAcceptanceCriteria(manualStory.description),
      };
    } else story = await readStory(storyId, tracker, project);
    const file = saveJson(story.id, "story.json", story);
    return ok(`Read ${story.tracker} story ${story.id} "${story.title}" with ${story.acceptanceCriteria.length} acceptance criteria. Saved to ${file}`, story);
  }),
);

// ================= 2. Generate test cases =================
server.registerTool(
  "generate_test_cases",
  {
    title: "Generate Test Cases",
    description:
      "Design test cases from the stored user story's acceptance criteria: positive per criterion, Gherkin parsing, negative (invalid data, required fields, email format), boundary values, and a UI smoke case. " +
      "Review the output — you can improve it and call save_test_cases with the refined list.",
    inputSchema: {
      storyId: z.string(),
      includeNegative: z.boolean().default(true),
      includeBoundary: z.boolean().default(true),
    },
  },
  safe(async ({ storyId, includeNegative, includeBoundary }) => {
    const story = loadStoryOrThrow(storyId);
    const cases = generateTestCases(story, { includeNegative, includeBoundary });
    saveJson(story.id, "testcases.json", cases);
    writeFile(path.join(storyDir(story.id), "testcases.md"), testCasesToMarkdown(story, cases));
    return ok(`Generated ${cases.length} test cases for ${story.id}. Saved testcases.json and testcases.md in ${storyDir(story.id)}`, cases);
  }),
);

server.registerTool(
  "save_test_cases",
  {
    title: "Save Test Cases",
    description: "Replace the stored test cases for a story with your own (e.g. AI-refined) list. Used by upload and code generation.",
    inputSchema: { storyId: z.string(), testCases: z.array(testCaseSchema).min(1) },
  },
  safe(async ({ storyId, testCases }) => {
    const story = loadStoryOrThrow(storyId);
    const cases: TestCase[] = testCases.map((t, i) => ({ ...t, id: t.id ?? `TC-${String(i + 1).padStart(3, "0")}` }) as TestCase);
    saveJson(story.id, "testcases.json", cases);
    writeFile(path.join(storyDir(story.id), "testcases.md"), testCasesToMarkdown(story, cases));
    return ok(`Saved ${cases.length} test cases for ${story.id}.`);
  }),
);

// ================= 3. Upload =================
server.registerTool(
  "upload_test_cases",
  {
    title: "Upload Test Cases",
    description:
      "Create the stored test cases in the tracker the story came from. Jira: issues of type JIRA_TEST_ISSUE_TYPE (falls back to Task) with a steps table, linked to the story. " +
      "Azure DevOps: 'Test Case' work items with real test steps, linked with Tested By, optionally added to a test plan/suite.",
    inputSchema: {
      storyId: z.string(),
      project: z.string().optional().describe("Jira project key or Azure DevOps project (defaults from config / story)"),
      testPlanId: z.string().optional(),
      testSuiteId: z.string().optional(),
      onlyIds: z.array(z.string()).optional().describe("Upload only these local ids, e.g. ['TC-001']"),
      skipAlreadyUploaded: z.boolean().default(true),
    },
  },
  safe(async ({ storyId, project, testPlanId, testSuiteId, onlyIds, skipAlreadyUploaded }) => {
    const story = loadStoryOrThrow(storyId);
    const all = requireJson<TestCase[]>(story.id, "testcases.json", "Call generate_test_cases first.");
    const todo = all.filter((c) => (!onlyIds || onlyIds.includes(c.id)) && (!skipAlreadyUploaded || !c.externalId));
    if (!todo.length) return ok("Nothing to upload (all selected test cases already have an external id).");
    const uploaded = await uploadTestCases(story, todo, { project, testPlanId, testSuiteId });
    const merged = all.map((c) => uploaded.find((u) => u.id === c.id) ?? c);
    saveJson(story.id, "testcases.json", merged);
    writeFile(path.join(storyDir(story.id), "testcases.md"), testCasesToMarkdown(story, merged));
    return ok(
      `Uploaded ${uploaded.length} test cases to ${story.tracker === "jira" ? "Jira" : "Azure DevOps"}.`,
      uploaded.map((u) => ({ id: u.id, externalId: u.externalId, url: u.externalUrl, title: u.title })),
    );
  }),
);

// ================= 4. Locators =================
server.registerTool(
  "detect_locators",
  {
    title: "Detect Locators",
    description:
      "Open each page in headless Chromium, find visible interactive elements (inputs, buttons, links, selects, checkboxes, headings, error messages) and pick the most robust locator for each " +
      "(data-testid → role+name → label → placeholder → stable id → name → text → css). Every locator is verified to match exactly that one element.",
    inputSchema: {
      storyId: z.string(),
      pages: pagesSchema,
      login: loginSchema,
      storageStatePath: z.string().optional().describe("Playwright storageState file for authenticated sessions"),
      headless: z.boolean().default(true),
      waitMs: z.number().int().min(0).max(30000).default(500),
      maxElementsPerPage: z.number().int().min(5).max(300).default(80),
      localStorage: z
        .record(z.string(), z.string())
        .optional()
        .describe('Values written to localStorage before pages load, e.g. {"tenantId":"1"} to skip a country/tenant picker'),
    },
  },
  safe(async ({ storyId, pages, login, storageStatePath, headless, waitMs, maxElementsPerPage, localStorage }) => {
    const result = await detectLocators({ pages, login, storageStatePath, headless, waitMs, maxElementsPerPage, localStorage });
    saveJson(storyId, "browser-setup.json", { localStorage: localStorage ?? {} });
    saveJson(storyId, "locators.json", result);
    return ok(
      `Detected locators on ${result.length} page(s): ${result.map((p) => `${p.pageName} (${p.locators.length})`).join(", ")}`,
      result.map((p) => ({ page: p.pageName, url: p.url, locators: p.locators.map((l) => ({ key: l.key, type: l.elementType, locator: l.playwright })) })),
    );
  }),
);

// ================= 5. Generate project =================
server.registerTool(
  "generate_automation_project",
  {
    title: "Generate Automation Project (POM)",
    description:
      "Generate / update a Playwright + TypeScript automation project using the Page Object Model: BasePage, one page class per detected page, fixtures that inject pages, " +
      "a spec per story generated from the test cases, test data, Allure reporting and CI pipelines (GitHub Actions + Azure Pipelines). " +
      "Point projectDir at an existing generated project to add more stories to it.",
    inputSchema: {
      storyId: z.string(),
      projectDir: z.string().optional().describe("Defaults to <workspace>/<storyId>/automation"),
      projectName: z.string().optional(),
      baseUrl: z.string().url().optional().describe("Defaults to APP_BASE_URL or the first page's origin"),
      overwritePages: z.boolean().default(true),
      singleFileReport: z.boolean().default(false).describe("Allure report as a single shareable HTML file"),
      credentials: z
        .object({ username: z.string(), password: z.string() })
        .optional()
        .describe("Valid test credentials written to data/testData.json (otherwise CHANGE_ME placeholders)"),
    },
  },
  safe(async ({ storyId, projectDir, projectName, baseUrl, overwritePages, singleFileReport, credentials }) => {
    const story = loadStoryOrThrow(storyId);
    const testCases = requireJson<TestCase[]>(story.id, "testcases.json", "Call generate_test_cases first.");
    const pages = requireJson<PageLocators[]>(story.id, "locators.json", "Call detect_locators first.");
    const dir = projectDirFor(storyId, projectDir);
    const res = generateProject({
      projectDir: dir,
      projectName: projectName ?? `${story.id}-ui-automation`,
      baseUrl: baseUrl || config.defaultBaseUrl || new URL(pages[0].url).origin,
      story,
      testCases,
      pages,
      overwritePages,
      singleFileReport,
      credentials,
    });
    const pending = res.pendingSteps.reduce((n, p) => n + p.items.length, 0);
    return ok(
      `Generated ${res.files.length} files in ${dir}. ${res.automatedSteps} step(s) automated, ${pending} step(s) need manual implementation (they show as fixme until done).`,
      { files: res.files, pendingSteps: res.pendingSteps },
    );
  }),
);

// ================= 6. Git =================
server.registerTool(
  "git_commit_push",
  {
    title: "Commit & Push",
    description:
      "Commit the automation project and push it to GitHub or Azure Repos. Creates the remote repository if it doesn't exist. Credentials are used only for the push and never written to .git/config.",
    inputSchema: {
      storyId: z.string().optional(),
      projectDir: z.string().optional(),
      provider: z.enum(["github", "azure"]),
      repoName: z.string(),
      branch: z.string().optional().describe("Defaults to GIT_DEFAULT_BRANCH (main)"),
      commitMessage: z.string().optional(),
      owner: z.string().optional().describe("GitHub user/org (defaults to GITHUB_OWNER or token owner)"),
      azureProject: z.string().optional(),
      createRepoIfMissing: z.boolean().default(true),
      privateRepo: z.boolean().default(true),
    },
  },
  safe(async (a) => {
    const dir = projectDirFor(a.storyId, a.projectDir);
    const r = await commitAndPush({
      projectDir: dir,
      provider: a.provider,
      repoName: a.repoName,
      branch: a.branch,
      owner: a.owner,
      azureProject: a.azureProject,
      createRepoIfMissing: a.createRepoIfMissing,
      privateRepo: a.privateRepo,
      commitMessage: a.commitMessage ?? `${a.storyId ?? "qa"}: update generated UI automation`,
    });
    return ok(`Pushed ${r.commit.slice(0, 8)} to ${r.webUrl} (branch ${r.branch})${r.createdRepo ? " — repository was created" : ""}.`, r);
  }),
);

// ================= 7. Run =================
server.registerTool(
  "run_tests",
  {
    title: "Run Automation",
    description: "Install dependencies if needed and run the Playwright tests. Results go to allure-results/ and test-results/results.json. Returns a pass/fail summary with failure messages.",
    inputSchema: {
      storyId: z.string().optional(),
      projectDir: z.string().optional(),
      grep: z.string().optional().describe("Run only tests matching this title/tag, e.g. @high or TC-001"),
      baseUrl: z.string().url().optional(),
      headed: z.boolean().default(false),
      workers: z.number().int().min(1).max(16).optional(),
      installDependencies: z.boolean().optional().describe("Default: only when node_modules is missing"),
      allowPendingSteps: z.boolean().default(false).describe("Run tests that still contain unimplemented steps instead of marking them fixme"),
    },
  },
  safe(async (a) => {
    const dir = projectDirFor(a.storyId, a.projectDir);
    const r = await runTests({ projectDir: dir, grep: a.grep, baseUrl: a.baseUrl, headed: a.headed, workers: a.workers, installDependencies: a.installDependencies, allowPendingSteps: a.allowPendingSteps });
    const s = r.summary;
    const headline = s
      ? `Run finished: ${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped, ${s.flaky} flaky (of ${s.total}) in ${(s.durationMs / 1000).toFixed(1)}s.`
      : `Run finished with exit code ${r.exitCode} (no results file found).`;
    return ok(headline, { exitCode: r.exitCode, summary: s, install: r.install, outputTail: s?.failed || !s ? r.outputTail : undefined });
  }),
);

// ================= 8. Report =================
server.registerTool(
  "generate_allure_report",
  {
    title: "Generate Allure Report",
    description: "Build the Allure 3 HTML report from allure-results (no Java needed). Optionally serve and open it in the default browser.",
    inputSchema: {
      storyId: z.string().optional(),
      projectDir: z.string().optional(),
      reportName: z.string().optional(),
      open: z.boolean().default(false),
    },
  },
  safe(async (a) => {
    const dir = projectDirFor(a.storyId, a.projectDir);
    const story = a.storyId ? loadJson<UserStory>(a.storyId, "story.json") : undefined;
    const r = await generateAllureReport({ projectDir: dir, reportName: a.reportName ?? (story ? `${story.id} — ${story.title}` : undefined), open: a.open });
    return ok(`Allure report generated from ${r.resultFiles} result files: ${r.indexHtml}`, r);
  }),
);

// ================= Full pipeline =================
server.registerTool(
  "run_qa_pipeline",
  {
    title: "Run Full QA Sprint Pipeline",
    description:
      "One call for the whole loop: read story → generate test cases → upload to tracker → detect locators → generate POM project → commit & push → run → Allure report. " +
      "Each step's outcome is reported; a failing upload or push doesn't stop the run.",
    inputSchema: {
      storyId: z.string(),
      tracker: trackerEnum.optional(),
      trackerProject: z.string().optional(),
      pages: pagesSchema.describe("Pages of the application under test, the first one is the entry page"),
      baseUrl: z.string().url().optional(),
      login: loginSchema,
      projectDir: z.string().optional(),
      projectName: z.string().optional(),
      uploadTestCases: z.boolean().default(true),
      testPlanId: z.string().optional(),
      testSuiteId: z.string().optional(),
      git: z
        .object({ provider: z.enum(["github", "azure"]), repoName: z.string(), branch: z.string().optional(), owner: z.string().optional(), azureProject: z.string().optional() })
        .optional()
        .describe("Omit to skip commit & push"),
      runTests: z.boolean().default(true),
      generateReport: z.boolean().default(true),
      allowPendingSteps: z.boolean().default(false),
      credentials: z.object({ username: z.string(), password: z.string() }).optional().describe("Valid test credentials (defaults to login.username/password)"),
    },
  },
  safe(async (a, extra) => {
    const token = extra?._meta?.progressToken;
    const progress = (message: string, progress: number, total: number) => {
      console.error(`[qa-mcp] ${progress}/${total} ${message}`);
      if (token !== undefined)
        void extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress, total, message } }).catch(() => undefined);
    };
    const log = await runPipeline({ ...a, git: a.git ?? null }, progress);
    const lines = log.map((l) => `${l.status === "done" ? "✅" : l.status === "skipped" ? "⏭️" : "❌"} ${l.step} — ${l.detail}`);
    return ok(`QA pipeline for ${a.storyId} finished.\n\n${lines.join("\n")}`);
  }),
);

// ================= Status =================
server.registerTool(
  "get_workspace_status",
  {
    title: "Workspace Status",
    description: "Show which artifacts exist for a story (story, test cases, locators, project, results, report).",
    inputSchema: { storyId: z.string() },
  },
  safe(async ({ storyId }) => {
    const dir = storyDir(storyId);
    const proj = defaultProjectDir(storyId);
    const has = (p: string) => fs.existsSync(p);
    return ok(`Workspace for ${storyId}: ${dir}`, {
      story: has(path.join(dir, "story.json")),
      testCases: (loadJson<TestCase[]>(storyId, "testcases.json") ?? []).length,
      uploaded: (loadJson<TestCase[]>(storyId, "testcases.json") ?? []).filter((c) => c.externalId).length,
      locatorPages: (loadJson<PageLocators[]>(storyId, "locators.json") ?? []).map((p) => p.pageName),
      project: has(path.join(proj, "package.json")) ? proj : null,
      allureResults: has(path.join(proj, "allure-results")),
      allureReport: has(path.join(proj, "allure-report", "index.html")) ? path.join(proj, "allure-report", "index.html") : null,
    });
  }),
);

// ================= Prompt =================
server.registerPrompt(
  "qa_sprint",
  {
    title: "QA sprint for a user story",
    description: "Walk through the full QA loop for a story, reviewing test cases before upload.",
    argsSchema: { storyId: z.string(), appUrl: z.string() },
  },
  ({ storyId, appUrl }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Run the QA sprint for story ${storyId} against ${appUrl}:\n` +
            `1. read_user_story\n2. generate_test_cases, then review them as a senior QA engineer: add missing edge cases, fix vague steps ` +
            `(steps should name the field/button and quote any data, e.g. Enter "tomsmith" in the Username field), then save_test_cases\n` +
            `3. upload_test_cases\n4. detect_locators for the relevant pages\n5. generate_automation_project\n6. git_commit_push\n7. run_tests\n8. generate_allure_report\n` +
            `Summarise results and list any pending (not yet automated) steps.`,
        },
      },
    ],
  }),
);

async function main() {
  fs.mkdirSync(config.workspaceDir, { recursive: true });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[qa-mcp] ready — workspace: ${config.workspaceDir}`);
}

main().catch((e) => {
  console.error("[qa-mcp] fatal", e);
  process.exit(1);
});
