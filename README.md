# QA MCP — the QA sprint loop as an MCP server

An MCP server that takes a user story all the way to an Allure report:

```
User Story ─► Read it ─► Test cases ─► Upload ─► Locators ─► Code (POM) ─► Commit & Push ─► Run ─► Allure Report
 Jira / Azure DevOps                    Jira / ADO  Playwright   Playwright+TS     GitHub / Azure Repos      Allure 3
```

It works with any MCP client: Claude Desktop, Claude Code, VS Code (Copilot agent mode), Cursor, and others.

## Tools

| # | Tool | What it does |
|---|------|--------------|
| 1 | `read_user_story` | Reads a Jira issue (`QA-12`) or Azure DevOps work item (`4521`), including its acceptance criteria (bullets, `AC1:` lines or Gherkin scenarios). Accepts `manualStory` if you have no tracker access. |
| 2 | `generate_test_cases` | Rule-based test design: a positive case per criterion, Gherkin Given/When/Then parsing, negative cases for invalid data, required fields and email format, boundary values for length limits, and a UI smoke check. |
| 2b | `save_test_cases` | Replaces the stored cases with your own or AI-refined ones. |
| 3 | `upload_test_cases` | **Jira**: creates issues of type `Test` (falls back to `Task`) with a steps table, linked to the story. **Azure DevOps**: creates `Test Case` work items with real test steps, linked as *Tested By*, and optionally adds them to a test plan/suite. |
| 4 | `detect_locators` | Opens each page in headless Chromium and picks the most robust locator for every visible element (`data-testid` → role+name → label → placeholder → stable id → name → text → css). Each locator is checked to match exactly that one element. Supports a login step or a `storageState` file. |
| 5 | `generate_automation_project` | Generates a **Playwright + TypeScript Page Object Model** project: `BasePage`, one page class per screen, fixtures that inject the pages, a spec per story built from the test cases, test data, Allure labels and links back to the story and test cases, plus GitHub Actions and Azure Pipelines CI. |
| 6 | `git_commit_push` | Commits the project and pushes it to **GitHub** or **Azure Repos**, creating the repo if it doesn't exist. The token is used only for the push and never written to `.git/config`. |
| 7 | `run_tests` | Installs dependencies if needed, runs Playwright, and returns passed/failed/skipped counts with failure messages. |
| 8 | `generate_allure_report` | Builds the Allure 3 HTML report. This needs Node only, no Java. It can also open the report in your browser. |
| ★ | `run_qa_pipeline` | Runs the whole loop in one call, with progress notifications. A failed upload or push is reported and the pipeline continues. |
| — | `get_workspace_status` | Shows which artifacts exist for a story. |

There is also a `qa_sprint` **prompt**. It asks the AI to review and improve the generated test cases before they are uploaded.

All artifacts are stored per story under `workspace/<storyId>/` (`story.json`, `testcases.json`, `testcases.md`, `locators.json`, `automation/`). Later tools only need the `storyId`.

## Install (Windows)

Requirements: **Node.js 18.17+** and **Git**.

```powershell
cd F:\Automation\QA_MCP
npm install          # also downloads Playwright's Chromium
npm run build
copy .env.example .env   # then fill in your Jira / Azure DevOps / GitHub values
```

Test it in the MCP Inspector:
```powershell
npm run inspect
```

## Connect it to your MCP client

**Claude Desktop**: edit `%APPDATA%\Claude\claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "qa-mcp": {
      "command": "node",
      "args": ["F:\\Automation\\QA_MCP\\dist\\index.js"]
    }
  }
}
```

**Claude Code**:
```powershell
claude mcp add qa-mcp -- node F:\Automation\QA_MCP\dist\index.js
```

**VS Code** (`.vscode/mcp.json`):
```json
{
  "servers": {
    "qa-mcp": { "type": "stdio", "command": "node", "args": ["F:\\Automation\\QA_MCP\\dist\\index.js"] }
  }
}
```

Secrets go in `.env` next to `package.json`, or in an `"env": { ... }` block in the client config. Values in the client config take priority.

## Example prompts

> Run the QA pipeline for Jira story QA-123 against https://staging.myapp.com/login and https://staging.myapp.com/dashboard, push to GitHub repo `myapp-ui-tests`, and give me the Allure report.

> Read Azure DevOps story 4521, generate test cases, and let me review them before uploading.

> Detect locators on https://staging.myapp.com/checkout (log in first as qa@myapp.com / ****), then regenerate the automation project.

## Generated project

```
automation/
├─ pages/              BasePage.ts + LoginPage.ts, DashboardPage.ts … (locators + actions)
├─ fixtures/pages.ts   test.extend<{ loginPage, dashboardPage … }>
├─ tests/qa-123.spec.ts
├─ data/testData.json  valid/invalid values per input (replace CHANGE_ME values or pass `credentials`)
├─ utils/              assertions + pendingStep helper
├─ playwright.config.ts   reporters: list + allure-playwright + json
├─ allurerc.mjs
├─ .github/workflows/playwright.yml
└─ azure-pipelines.yml
```

Test steps are turned into page-object calls, for example:
`Enter "tomsmith" in the Username field` → `await loginPage.enterUsernameInput('tomsmith')`,
`Then the user is redirected to the Dashboard page` → `await dashboardPage.expectLoaded()`.
A precondition such as *"Given the user is logged in"* runs the detected login form first.

Some steps can't be matched to a locator (vague wording, or elements on a page you didn't crawl). These become `pendingStep()` calls, and the test is reported as **fixme** (skipped with a reason) instead of passing falsely. Set `allowPendingSteps: true` to run them anyway.

**Tip:** steps work best when they name the field or button and quote the data, e.g. `Enter "abc" in the Email field`, `Click the Save button`, `Then "Saved successfully" is displayed`. The `qa_sprint` prompt asks the AI to rewrite steps this way.

To add more stories to the same automation repo, pass the same `projectDir` to `generate_automation_project`. New page objects and specs are added, and existing `package.json`, config and test data edits are kept.

## Notes and limits
- **Jira + Xray/Zephyr**: test cases are created as regular issues of the configured type, with steps in the description. Native Xray step fields need Xray's own API.
- Test case generation is deterministic. For richer cases, let your AI client review them and call `save_test_cases` (the `qa_sprint` prompt does this).
- Locator detection covers the pages you list. For multi-step flows (wizards, modals), run it on each state's URL or use a `storageState` file.
