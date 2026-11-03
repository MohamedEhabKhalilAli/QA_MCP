import { config, requireValue } from "../config.js";
import { TestCase, UserStory } from "../types.js";
import { HttpError, basicAuth, http } from "../utils/http.js";
import { escapeXml, extractAcceptanceCriteria, htmlToText } from "../utils/text.js";

function org(): string {
  return requireValue(config.azure.orgUrl, "AZDO_ORG_URL").replace(/\/+$/, "");
}

/**
 * HTTP call to Azure DevOps (cloud or on-prem Server). If the server doesn't support the configured
 * api-version (older Azure DevOps Server / TFS), retry with older versions and remember the one that works.
 */
export async function azHttp<T = any>(url: string, opts: Parameters<typeof http>[1] = {}): Promise<T> {
  const fallbacks = ["7.1", "7.0", "6.0", "5.1", "5.0"].filter((x) => x !== config.azure.apiVersion);
  let current = url;
  for (let i = 0; ; i++) {
    try {
      return await http<T>(current, opts);
    } catch (e) {
      const unsupported =
        e instanceof HttpError && (e.status === 400 || e.status === 404) && /VssVersionOutOfRange|out of range|api-version|not supported/i.test(e.responseText);
      if (!unsupported || i >= fallbacks.length || !/api-version=/.test(current)) throw e;
      const next = fallbacks[i];
      current = current.replace(/api-version=[^&]+/, `api-version=${next}`);
      config.azure.apiVersion = next;
      console.error(`[qa-mcp] Azure DevOps rejected the API version, retrying with ${next}`);
    }
  }
}
/** Accepts "Next Team" or an already-encoded "Next%20Team". */
export function azProjectSegment(p?: string): string {
  const name = p || requireValue(config.azure.project, "AZDO_PROJECT");
  let decoded = name;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    /* keep as is */
  }
  return encodeURIComponent(decoded);
}
const project = azProjectSegment;
function headers(): Record<string, string> {
  return { Authorization: basicAuth("", requireValue(config.azure.pat, "AZDO_PAT")) };
}
const v = () => `api-version=${config.azure.apiVersion}`;

export async function readAzureStory(id: string, projectName?: string): Promise<UserStory> {
  let wi: any;
  try {
    wi = await azHttp<any>(`${org()}/${project(projectName)}/_apis/wit/workitems/${encodeURIComponent(id)}?${v()}`, { headers: headers() });
  } catch (e) {
    // The work item may live in another project: work item ids are unique per collection, so retry without the project.
    if (!(e instanceof HttpError && e.status === 404)) throw e;
    try {
      wi = await azHttp<any>(`${org()}/_apis/wit/workitems/${encodeURIComponent(id)}?${v()}`, { headers: headers() });
    } catch {
      throw new Error(
        `[qa-mcp] Azure DevOps could not return work item ${id}. ${e.responseText.slice(0, 300)}\n` +
          `Check: (1) the PAT's user is a member of project "${decodeURIComponent(project(projectName))}" and can open the item in the browser, ` +
          `(2) the PAT has the "Work Items (Read & Write)" scope and is not expired, (3) AZDO_ORG_URL points to the right collection.`,
      );
    }
  }
  const f = wi.fields ?? {};
  const description = htmlToText(f["System.Description"]);
  const acText = htmlToText(f["Microsoft.VSTS.Common.AcceptanceCriteria"]);
  // An Acceptance Criteria field holding only "-" / "N/A" is treated as empty -> parse the description instead
  const meaningful = acText.replace(/\b(n\/?a|none|tbd)\b/gi, "").replace(/[\W_]/g, "").length >= 5;
  let acceptanceCriteria = meaningful ? extractAcceptanceCriteria(`Acceptance Criteria:\n${acText}`) : [];
  if (!acceptanceCriteria.length) acceptanceCriteria = extractAcceptanceCriteria(description);
  return {
    tracker: "azure",
    id: String(wi.id),
    title: f["System.Title"],
    description,
    acceptanceCriteria,
    status: f["System.State"],
    labels: (f["System.Tags"] ?? "").split(";").map((s: string) => s.trim()).filter(Boolean),
    url: wi._links?.html?.href ?? `${org()}/${project(projectName)}/_workitems/edit/${wi.id}`,
  };
}

/** Build the Microsoft.VSTS.TCM.Steps XML used by Azure Test Plans. */
export function buildStepsXml(tc: TestCase): string {
  const html = (s: string) => escapeXml(`<DIV><P>${escapeXml(s)}</P></DIV>`);
  const steps = tc.steps.map((s, i) => {
    const action = s.data ? `${s.action} (Data: ${s.data})` : s.action;
    return (
      `<step id="${i + 2}" type="${s.expected ? "ValidateStep" : "ActionStep"}">` +
      `<parameterizedString isformatted="true">${html(action)}</parameterizedString>` +
      `<parameterizedString isformatted="true">${html(s.expected ?? "")}</parameterizedString>` +
      `<description/></step>`
    );
  });
  return `<steps id="0" last="${tc.steps.length + 1}">${steps.join("")}</steps>`;
}

const priorityMap = { High: 1, Medium: 2, Low: 3 } as const;

export async function uploadAzureTestCases(
  storyId: string,
  testCases: TestCase[],
  opts: { project?: string; testPlanId?: string; testSuiteId?: string } = {},
): Promise<TestCase[]> {
  const results: TestCase[] = [];
  const createdIds: number[] = [];
  for (const tc of testCases) {
    const desc = [
      `<p>Generated by QA MCP from user story #${storyId}.</p>`,
      tc.objective ? `<p><b>Objective:</b> ${escapeXml(tc.objective)}</p>` : "",
      tc.preconditions?.length
        ? `<p><b>Preconditions:</b></p><ul>${tc.preconditions.map((p) => `<li>${escapeXml(p)}</li>`).join("")}</ul>`
        : "",
      `<p><b>Type:</b> ${tc.type}</p>`,
    ].join("");

    const ops: any[] = [
      { op: "add", path: "/fields/System.Title", value: tc.title.slice(0, 255) },
      { op: "add", path: "/fields/System.Description", value: desc },
      { op: "add", path: "/fields/Microsoft.VSTS.TCM.Steps", value: buildStepsXml(tc) },
      { op: "add", path: "/fields/Microsoft.VSTS.Common.Priority", value: priorityMap[tc.priority] ?? 2 },
      { op: "add", path: "/fields/System.Tags", value: ["qa-mcp", "auto-generated", tc.type, ...(tc.tags ?? [])].join("; ") },
      {
        op: "add",
        path: "/relations/-",
        value: {
          rel: "Microsoft.VSTS.Common.TestedBy-Reverse",
          url: `${org()}/_apis/wit/workItems/${storyId}`,
          attributes: { comment: "Generated by QA MCP" },
        },
      },
    ];
    if (config.azure.areaPath) ops.push({ op: "add", path: "/fields/System.AreaPath", value: config.azure.areaPath });
    if (config.azure.iterationPath)
      ops.push({ op: "add", path: "/fields/System.IterationPath", value: config.azure.iterationPath });

    const created = await azHttp<any>(`${org()}/${project(opts.project)}/_apis/wit/workitems/$Test%20Case?${v()}`, {
      method: "POST",
      headers: headers(),
      body: ops,
      contentType: "application/json-patch+json",
    });
    createdIds.push(created.id);
    results.push({
      ...tc,
      externalId: String(created.id),
      externalUrl: created._links?.html?.href ?? `${org()}/${project(opts.project)}/_workitems/edit/${created.id}`,
    });
  }

  const planId = opts.testPlanId || config.azure.testPlanId;
  const suiteId = opts.testSuiteId || config.azure.testSuiteId;
  if (planId && suiteId && createdIds.length) {
    await azHttp(`${org()}/${project(opts.project)}/_apis/testplan/Plans/${planId}/Suites/${suiteId}/TestCase?${v()}`, {
      method: "POST",
      headers: headers(),
      body: createdIds.map((id) => ({ workItem: { id } })),
    });
  }
  return results;
}
