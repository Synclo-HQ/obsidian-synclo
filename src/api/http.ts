/**
 * The one way the plugin talks to the network. The plugin passes an
 * implementation built on Obsidian's requestUrl (obsidian-http.ts); tests
 * pass a stand-in. Every request is to the Synclo server the person set,
 * except a file download, which follows Synclo's file link to storage.
 */

export interface HttpRequest {
  url: string;
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
  contentType?: string;
  /** Give up waiting after this long. The request itself can't be
   *  stopped (requestUrl has no abort); its answer is ignored. */
  timeoutMs: number;
}

export interface HttpResponse {
  status: number;
  /** Header names in lower case. */
  headers: Record<string, string>;
  text(): string;
  arrayBuffer(): ArrayBuffer;
}

export type Http = (request: HttpRequest) => Promise<HttpResponse>;

/** The request never got an answer: no connection, or it took too long. */
export class NetworkError extends Error {
  constructor(
    message: string,
    readonly timedOut: boolean,
  ) {
    super(message);
    this.name = "NetworkError";
  }
}

/** The body parsed as JSON, or null. */
export function jsonOf(response: HttpResponse): unknown {
  try {
    const text = response.text();
    return text ? (JSON.parse(text) as unknown) : null;
  } catch {
    return null;
  }
}

export function headerOf(response: HttpResponse, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(response.headers)) if (k.toLowerCase() === lower) return v;
  return undefined;
}

/** Seconds from a Retry-After header (seconds or a date), else null. */
export function retryAfterOf(response: HttpResponse, now: number): number | null {
  const v = headerOf(response, "retry-after");
  if (!v) return null;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.max(0, n);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, Math.round((at - now) / 1000)) : null;
}

/** UTF-8 bytes in a string. */
export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

export function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
