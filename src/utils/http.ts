export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  contentType?: string;
}

export class HttpError extends Error {
  constructor(public status: number, public url: string, public responseText: string) {
    super(`HTTP ${status} for ${url}: ${responseText.slice(0, 800)}`);
  }
}

export async function http<T = any>(url: string, opts: HttpOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json", ...(opts.headers ?? {}) };
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["Content-Type"] = opts.contentType ?? "application/json";
    body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(url, { method: opts.method ?? (body ? "POST" : "GET"), headers, body });
  } catch (e) {
    // Node's "fetch failed" hides the real reason (DNS, proxy, TLS inspection…) in e.cause
    const c: any = (e as any)?.cause;
    const detail = c ? `${c.code ?? ""} ${c.message ?? c}`.trim() : String(e);
    throw new Error(
      `Network error calling ${new URL(url).host}: ${detail}. ` +
        (/CERT|SELF_SIGNED|UNABLE_TO/i.test(detail)
          ? "A proxy/firewall is inspecting HTTPS: set NODE_EXTRA_CA_CERTS to your company root certificate in the MCP client env."
          : /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|UND_ERR_CONNECT/i.test(detail)
            ? "The host is not reachable from this PC (firewall or proxy). Check you can open it in a browser / curl."
            : ""),
    );
  }
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, url, text);
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

export const basicAuth = (user: string, secret: string) =>
  "Basic " + Buffer.from(`${user}:${secret}`).toString("base64");
