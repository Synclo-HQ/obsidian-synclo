import type { Http, HttpRequest, HttpResponse } from "../src/api/http";
import type { LocalStore, SecretStore } from "../src/auth/session";

export interface FakeAnswer {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  raw?: string;
}
export type Handler = (req: HttpRequest) => FakeAnswer | Promise<FakeAnswer>;

/** A stand-in for Synclo's server: answers each request with the handler,
 *  and keeps every request for the test to read. */
export function fakeHttp(handler: Handler): { http: Http; requests: HttpRequest[] } {
  const requests: HttpRequest[] = [];
  const http: Http = async (req) => {
    requests.push(req);
    const a = await handler(req);
    const text = a.raw ?? (a.body === undefined ? "" : JSON.stringify(a.body));
    const res: HttpResponse = {
      status: a.status,
      headers: { "content-type": "application/json", ...(a.headers ?? {}) },
      text: () => text,
      arrayBuffer: () => new TextEncoder().encode(text).buffer,
    };
    return res;
  };
  return { http, requests };
}

export function memorySecrets(): SecretStore & { all: Map<string, string> } {
  const all = new Map<string, string>();
  return {
    all,
    get: (id) => all.get(id) || null,
    set: (id, value) => {
      if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`bad secret id ${id}`);
      if (value) all.set(id, value);
      else all.delete(id);
    },
  };
}

export function form(req: HttpRequest): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(typeof req.body === "string" ? req.body : ""));
}

export function rpcResult(structuredContent: Record<string, unknown>, isError = false, text = "ok") {
  return { status: 200, body: { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }], structuredContent, ...(isError ? { isError: true } : {}) } } };
}

export function memoryLocal(): LocalStore & { all: Map<string, unknown> } {
  const all = new Map<string, unknown>();
  return {
    all,
    load: (key) => (all.has(key) ? all.get(key) : null),
    save: (key, value) => {
      if (value === null || value === undefined) all.delete(key);
      else all.set(key, JSON.parse(JSON.stringify(value)) as unknown);
    },
  };
}
