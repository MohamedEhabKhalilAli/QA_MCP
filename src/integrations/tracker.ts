import { config } from "../config.js";
import { TestCase, Tracker, UserStory } from "../types.js";
import { readAzureStory, uploadAzureTestCases } from "./azureDevOps.js";
import { readJiraStory, uploadJiraTestCases } from "./jira.js";

export function resolveTracker(tracker: Tracker | undefined, storyId: string): Tracker {
  if (tracker) return tracker;
  if (/^[A-Z][A-Z0-9_]+-\d+$/i.test(storyId)) return "jira";
  if (/^\d+$/.test(storyId)) return "azure";
  return config.defaultTracker;
}

export async function readStory(storyId: string, tracker?: Tracker, project?: string): Promise<UserStory> {
  const t = resolveTracker(tracker, storyId);
  return t === "jira" ? readJiraStory(storyId) : readAzureStory(storyId, project);
}

export async function uploadTestCases(
  story: Pick<UserStory, "id" | "tracker">,
  testCases: TestCase[],
  opts: { project?: string; testPlanId?: string; testSuiteId?: string } = {},
): Promise<TestCase[]> {
  return story.tracker === "jira"
    ? uploadJiraTestCases(story.id, testCases, opts.project)
    : uploadAzureTestCases(story.id, testCases, opts);
}
