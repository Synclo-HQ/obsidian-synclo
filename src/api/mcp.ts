import type { Session } from "../auth/session";
import { endpoints } from "../auth/oauth";
import { MESSAGES, SyncloError } from "./errors";
import { NetworkError, headerOf, isRecord, jsonOf, retryAfterOf, utf8Length, type Http, type HttpResponse } from "./http";

/**
 * Synclo's connector tools, called over HTTP: one JSON-RPC message per
 * POST to {base}/mcp, no session (Synclo's server is stateless). A 401 is
 * answered by one refresh and one retry; a 503 keeps the sign-in.
 */

export const MAX_BODY_BYTES = 1024 * 1024;
const PROTOCOL = "2025-11-25";

export interface McpDeps {
  http: Http;
  session: Session;
  base: () => string;
  now: () => number;
}

export interface CallOptions {
  /** How long to wait for the answer. */
  timeoutMs?: number;
}

export class McpClient {
  private id = 0;

  constructor(private readonly deps: McpDeps) {}

  /** Calls a tool and returns its structured result. A tool that couldn't
   *  do what was asked throws a SyncloError with Synclo's code. */
  async call(name: string, args: Record<string, unknown>, options: CallOptions = {}): Promise<Record<string, unknown>> {
    const id = ++this.id;
    const body = JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    if (utf8Length(body) > MAX_BODY_BYTES) throw new SyncloError("too-large", "This is too much to send to Synclo in one go (the limit is 1 MB). Try a shorter note, or a selection.");
    const timeoutMs = options.timeoutMs ?? 60_000;

    let token = await this.deps.session.accessToken();
    let res = await this.post(body, token, timeoutMs);
    if (res.status === 401) {
      token = await this.deps.session.tokenAfterRejection(token);
      res = await this.post(body, token, timeoutMs);
      if (res.status === 401) {
        this.deps.session.forget("expired");
        throw new SyncloError("signed-out", MESSAGES.signInEnded);
      }
    }
    return readAnswer(res, id, this.deps.now());
  }

  /** Uploads one of the note's pictures; returns its Synclo address. */
  async uploadPicture(bytes: ArrayBuffer, type: string): Promise<string> {
    const url = endpoints(this.deps.base()).images;
    const send = async (token: string) => {
      try {
        return await this.deps.http({ url, method: "POST", contentType: type, headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, body: bytes, timeoutMs: 120_000 });
      } catch (err) {
        throw toNetworkFailure(err);
      }
    };
    let token = await this.deps.session.accessToken();
    let res = await send(token);
    if (res.status === 401) {
      token = await this.deps.session.tokenAfterRejection(token);
      res = await send(token);
      if (res.status === 401) {
        this.deps.session.forget("expired");
        throw new SyncloError("signed-out", MESSAGES.signInEnded);
      }
    }
    const answer = jsonOf(res);
    const err = isRecord(answer) ? answer : {};
    const description = typeof err.error_description === "string" ? err.error_description : "";
    if (res.status === 200 && isRecord(answer) && typeof answer.url === "string" && /^https?:\/\//.test(answer.url)) return answer.url;
    if (res.status === 429) throw new SyncloError("rate-limited", description || MESSAGES.rateLimited, { retryAfter: retryAfterOf(res, this.deps.now()) ?? 600 });
    if (res.status === 503 || res.status >= 500) throw new SyncloError("unavailable", MESSAGES.unavailable);
    const code = typeof err.error === "string" ? err.error : `http_${res.status}`;
    throw new SyncloError("rejected", description || "Synclo couldn't take this image.", { code });
  }

  private async post(body: string, token: string, timeoutMs: number): Promise<HttpResponse> {
    try {
      return await this.deps.http({
        url: endpoints(this.deps.base()).mcp,
        method: "POST",
        contentType: "application/json",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": PROTOCOL,
        },
        body,
        timeoutMs,
      });
    } catch (err) {
      throw toNetworkFailure(err);
    }
  }
}

function toNetworkFailure(err: unknown): unknown {
  if (err instanceof NetworkError) return new SyncloError("network", MESSAGES.network);
  return err;
}

/** The JSON-RPC message in an answer: plain JSON, or Server-Sent Events. */
export function messageOf(res: HttpResponse, id: number): Record<string, unknown> | null {
  const type = (headerOf(res, "content-type") ?? "").toLowerCase();
  if (type.includes("text/event-stream")) {
    let found: Record<string, unknown> | null = null;
    for (const event of res.text().split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!data) continue;
      try {
        const msg = JSON.parse(data) as unknown;
        if (isRecord(msg) && (msg.id === id || (found === null && ("result" in msg || "error" in msg)))) found = msg;
      } catch {
        // Not a message.
      }
    }
    return found;
  }
  const msg = jsonOf(res);
  return isRecord(msg) ? msg : null;
}

/** A tool's answer as data, or the SyncloError it amounts to. */
export function readAnswer(res: HttpResponse, id: number, now: number): Record<string, unknown> {
  if (res.status === 429) throw new SyncloError("rate-limited", MESSAGES.rateLimited, { retryAfter: retryAfterOf(res, now) ?? 60 });
  if (res.status === 503 || res.status >= 500) throw new SyncloError("unavailable", MESSAGES.unavailable);
  if (res.status === 413) throw new SyncloError("too-large", "This is too much to send to Synclo in one go. Try a shorter note, or a selection.");
  const msg = messageOf(res, id);
  if (res.status === 403) {
    throw new SyncloError("rejected", "This connection can't do that. Disconnect and connect Synclo again to allow it.", { code: "insufficient_scope" });
  }
  if (!msg) throw new SyncloError("unavailable", MESSAGES.unavailable);
  if (isRecord(msg.error)) {
    const code = typeof msg.error.code === "number" ? msg.error.code : 0;
    const message = typeof msg.error.message === "string" ? msg.error.message : "Synclo refused the request.";
    if (code === -32602) throw new SyncloError("rejected", message, { code: "invalid_arguments" });
    if (code === -32000) throw new SyncloError("rate-limited", MESSAGES.rateLimited, { retryAfter: 60 });
    throw new SyncloError("rejected", message, { code: `rpc_${code}` });
  }
  const result = isRecord(msg.result) ? msg.result : null;
  if (!result) throw new SyncloError("unavailable", MESSAGES.unavailable);
  const structured = isRecord(result.structuredContent) ? result.structuredContent : {};
  if (result.isError === true) {
    const err = isRecord(structured.error) ? structured.error : {};
    const text = textOf(result);
    const code = typeof err.code === "string" ? err.code : /out of credits/i.test(text) ? "insufficient_credits" : "tool_error";
    const message = typeof err.message === "string" && err.message ? err.message : text || "Synclo couldn't do that.";
    const { code: _code, message: _message, ...extra } = err;
    throw new SyncloError("rejected", message, { code, extra });
  }
  return structured;
}

function textOf(result: Record<string, unknown>): string {
  const content = Array.isArray(result.content) ? result.content : [];
  return content
    .map((c) => (isRecord(c) && c.type === "text" && typeof c.text === "string" ? c.text : ""))
    .filter(Boolean)
    .join("\n");
}
