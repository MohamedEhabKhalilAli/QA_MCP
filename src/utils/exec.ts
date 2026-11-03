import { spawn } from "node:child_process";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/**
 * Run a command and capture output. Output is never forwarded to our stdout
 * (that channel belongs to the MCP protocol). Uses a shell so `npm`/`npx` resolve on Windows.
 */
export function run(
  command: string,
  args: string[],
  opts: { cwd: string; env?: Record<string, string>; timeoutMs?: number } = { cwd: process.cwd() },
): Promise<ExecResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: { ...process.env, FORCE_COLOR: "0", CI: "1", ...(opts.env ?? {}) },
      shell: true,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const cap = (s: string) => (s.length > 400_000 ? s.slice(-400_000) : s);
    child.stdout.on("data", (d) => (stdout = cap(stdout + d.toString())));
    child.stderr.on("data", (d) => (stderr = cap(stderr + d.toString())));
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          stderr += `\n[qa-mcp] Timed out after ${opts.timeoutMs} ms`;
          child.kill();
        }, opts.timeoutMs)
      : undefined;
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, durationMs: Date.now() - started });
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: stderr + String(err), durationMs: Date.now() - started });
    });
  });
}

export const tail = (s: string, n = 3000) => (s.length > n ? "…" + s.slice(-n) : s);
