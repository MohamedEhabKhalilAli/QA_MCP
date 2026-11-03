import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Loads a `.env` file that sits next to package.json (one level above dist/ or src/).
 * Written by hand (no dotenv) so that nothing is ever printed to stdout,
 * which would corrupt the MCP stdio protocol.
 * Values already present in process.env (e.g. from the MCP client config) win.
 */
function loadDotEnv(): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.resolve(here, "..", ".env"), path.resolve(process.cwd(), ".env")];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
    break;
  }
}
loadDotEnv();

const env = (k: string, d = ""): string => (process.env[k] ?? d).trim();

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const config = {
  workspaceDir: path.resolve(PROJECT_ROOT, env("QA_WORKSPACE_DIR", "workspace")),
  defaultTracker: env("DEFAULT_TRACKER", "jira") as "jira" | "azure",
  defaultBaseUrl: env("APP_BASE_URL"),

  jira: {
    baseUrl: env("JIRA_BASE_URL").replace(/\/+$/, ""),
    email: env("JIRA_EMAIL"),
    apiToken: env("JIRA_API_TOKEN"),
    /** "basic" (Jira Cloud: email + API token) or "bearer" (Jira Server/DC personal access token) */
    authType: env("JIRA_AUTH_TYPE", "basic") as "basic" | "bearer",
    /** 3 = Jira Cloud (ADF descriptions), 2 = Server/Data Center (plain-text descriptions) */
    apiVersion: env("JIRA_API_VERSION", "3"),
    projectKey: env("JIRA_PROJECT_KEY"),
    testIssueType: env("JIRA_TEST_ISSUE_TYPE", "Test"),
    fallbackIssueType: env("JIRA_FALLBACK_ISSUE_TYPE", "Task"),
    linkType: env("JIRA_LINK_TYPE", "Relates"),
    acceptanceCriteriaField: env("JIRA_ACCEPTANCE_CRITERIA_FIELD"),
    /** JSON object of extra fields for created test cases, e.g. {"customfield_10113":{"value":"Squad A"}} */
    extraFields: (() => {
      const raw = env("JIRA_EXTRA_FIELDS");
      if (!raw) return {} as Record<string, unknown>;
      try {
        return JSON.parse(raw) as Record<string, unknown>;
      } catch {
        console.error("[qa-mcp] JIRA_EXTRA_FIELDS is not valid JSON - ignored");
        return {} as Record<string, unknown>;
      }
    })(),
  },

  azure: {
    orgUrl: env("AZDO_ORG_URL").replace(/\/+$/, ""), // https://dev.azure.com/myorg
    project: env("AZDO_PROJECT"),
    pat: env("AZDO_PAT"),
    apiVersion: env("AZDO_API_VERSION", "7.1"),
    testPlanId: env("AZDO_TEST_PLAN_ID"),
    testSuiteId: env("AZDO_TEST_SUITE_ID"),
    areaPath: env("AZDO_AREA_PATH"),
    iterationPath: env("AZDO_ITERATION_PATH"),
  },

  github: {
    token: env("GITHUB_TOKEN"),
    owner: env("GITHUB_OWNER"),
    apiUrl: env("GITHUB_API_URL", "https://api.github.com").replace(/\/+$/, ""),
  },

  git: {
    authorName: env("GIT_AUTHOR_NAME", "QA MCP Bot"),
    authorEmail: env("GIT_AUTHOR_EMAIL", "qa-mcp@example.com"),
    defaultBranch: env("GIT_DEFAULT_BRANCH", "main"),
  },
};

export function requireValue(value: string, name: string): string {
  if (!value) throw new Error(`Missing configuration: ${name}. Set it in .env or in your MCP client "env" block.`);
  return value;
}
