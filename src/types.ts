export type Tracker = "jira" | "azure";

export interface UserStory {
  tracker: Tracker;
  id: string; // Jira key (ABC-123) or Azure work item id ("4521")
  title: string;
  description: string; // plain text
  acceptanceCriteria: string[]; // one entry per criterion / scenario
  status?: string;
  url?: string;
  labels?: string[];
  raw?: unknown;
}

export interface TestStep {
  action: string;
  expected?: string;
  data?: string;
}

export type Priority = "High" | "Medium" | "Low";
export type TestType = "Positive" | "Negative" | "Boundary" | "UI";

export interface TestCase {
  id: string; // local id TC-001
  title: string;
  objective?: string;
  preconditions?: string[];
  steps: TestStep[];
  priority: Priority;
  type: TestType;
  tags?: string[];
  sourceCriterion?: string;
  /** Filled in after upload */
  externalId?: string;
  externalUrl?: string;
}

export interface LocatorEntry {
  key: string; // camelCase name used in the page object, e.g. usernameInput
  description: string; // human readable: "Username input"
  elementType: string; // input | button | link | select | textarea | checkbox | radio | other
  strategy: "testId" | "id" | "role" | "label" | "placeholder" | "name" | "text" | "css";
  /** Playwright locator expression relative to `page`, e.g. page.getByRole('button', { name: 'Login' }) */
  playwright: string;
  /** Equivalent CSS / XPath selector useful for Selenium or debugging */
  css?: string;
  unique: boolean;
  alternatives?: string[];
}

export interface PageLocators {
  pageName: string; // LoginPage
  url: string;
  title?: string;
  locators: LocatorEntry[];
}
