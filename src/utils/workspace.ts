import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

/** Every story gets its own folder: <workspace>/<storyId>/ holding story.json, testcases.json, locators.json, automation project. */
export function storyDir(storyId: string): string {
  const safe = storyId.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const dir = path.join(config.workspaceDir, safe);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function saveJson(storyId: string, name: string, data: unknown): string {
  const file = path.join(storyDir(storyId), name);
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
  return file;
}

export function loadJson<T>(storyId: string, name: string): T | undefined {
  const file = path.join(storyDir(storyId), name);
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

export function requireJson<T>(storyId: string, name: string, hint: string): T {
  const v = loadJson<T>(storyId, name);
  if (v === undefined) throw new Error(`No ${name} found for ${storyId}. ${hint}`);
  return v;
}

export function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}
