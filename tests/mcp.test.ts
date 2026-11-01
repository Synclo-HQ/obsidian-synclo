import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import { NetworkError } from "../src/api/http";
import { McpClient } from "../src/api/mcp";
import { SyncloApi, documentIdOf, parseGeneration } from "../src/api/synclo";
import { SECRET_TOKENS, Session } from "../src/auth/session";
import { fakeHttp, memoryLocal, memorySecrets, rpcResult, type Handler } from "./fake-http";

const BASE = "https://synclo.app";

function client(handler: Handler) {
  const { http, requests } = fakeHttp(handler);
  const secrets = memorySecrets();
  secrets.set(SECRET_TOKENS, JSON.stringify({ v: 1, base: BASE, access: "syo_1", refresh: "syr_1", expiresAt: 9_999_999_999_999, scope: "" }));
  const session = new Session({ http, secrets, local: memoryLocal(), crypto: webcrypto as unknown as Crypto, now: () => 0, base: () => BASE });
  const mcp = new McpClient({ http, session, base: () => BASE, now: () => 0 });
  return { mcp, api: new SyncloApi(mcp), requests, secrets };
}

const isToken = (r: { url: string }) => r.url.endsWith("/oauth/token");
/** The tool arguments a request sent. */
const argsOf = (r: { body?: string | ArrayBuffer }) => (JSON.parse(r.body as string) as { params: { arguments: Record<string, unknown> } }).params.arguments;

describe("calling a tool", () => {
  it("sends one JSON-RPC message with the bearer token", async () => {
    const { api, requests } = client(() => rpcResult({ workspace: { name: "Example Studio" }, credits: { balance: 400 }, plan: { id: "free", slides_per_prompt: 10 } }));
    expect(await api.account()).toEqual({ workspace: "Example Studio", workspaceId: null, balance: 400, planId: "free", slidesPerPrompt: 10 });
    const req = requests[0]!;
    expect(req.url).toBe("https://synclo.app/mcp");
    expect(req.headers?.Authorization).toBe("Bearer syo_1");
    expect(req.headers?.Accept).toBe("application/json, text/event-stream");
    expect(req.contentType).toBe("application/json");
    expect(JSON.parse(req.body as string)).toEqual({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_account", arguments: {} } });
  });

  it("refreshes once on a 401 and tries again", async () => {
    let mcpCalls = 0;
    const { api, requests } = client((req) => {
      if (isToken(req)) return { status: 200, body: { access_token: "syo_2", refresh_token: "syr_2", expires_in: 3600 } };
      mcpCalls++;
      if (req.headers?.Authorization === "Bearer syo_1") return { status: 401, body: { error: "invalid_token" } };
      return rpcResult({ themes: [{ id: "cobalt", name: "Cobalt", kind: "prebuilt", description: "" }] });
    });
    expect(await api.themes()).toEqual([{ id: "cobalt", name: "Cobalt", kind: "prebuilt", description: "" }]);
    expect(mcpCalls).toBe(2);
    expect(requests.filter(isToken)).toHaveLength(1);
  });

  it("signs out after a second 401", async () => {
    const { api, secrets } = client((req) => (isToken(req) ? { status: 200, body: { access_token: "syo_2", refresh_token: "syr_2", expires_in: 3600 } } : { status: 401 }));
    await expect(api.themes()).rejects.toMatchObject({ kind: "signed-out" });
    expect(secrets.get(SECRET_TOKENS)).toBeNull();
  });

  it("keeps the sign-in on a 503", async () => {
    const { api, secrets } = client(() => ({ status: 503, body: { error: "temporarily_unavailable" } }));
    await expect(api.themes()).rejects.toMatchObject({ kind: "unavailable" });
    expect(secrets.get(SECRET_TOKENS)).not.toBeNull();
  });

  it("reads Synclo's error code from a failed tool", async () => {
    const { api } = client(() =>
      rpcResult({ error: { code: "insufficient_credits", message: "This workspace is out of credits. Add credits at synclo.app.", credits: { balance: 20, needed: 90 } } }, true, "This workspace is out of credits."),
    );
    await expect(api.create({ input: "x".repeat(200), mode: "condense", format: "slides", slides: 9 })).rejects.toMatchObject({
      kind: "rejected",
      code: "insufficient_credits",
      extra: { credits: { balance: 20, needed: 90 } },
    });
  });

  it("reads an older server's out-of-credits words", async () => {
    const { api } = client(() => ({ status: 200, body: { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "This workspace is out of credits. Add credits at synclo.app." }], isError: true } } }));
    await expect(api.create({ input: "brief", mode: "generate", format: "slides" })).rejects.toMatchObject({ code: "insufficient_credits" });
  });

  it("reads an answer sent as Server-Sent Events", async () => {
    const { api } = client(() => ({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      raw: `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [], structuredContent: { presentations: [{ id: "a", title: "Q3", updated_at: "2026-10-30", edit_url: "https://synclo.app/d/a" }] } } })}\n\n`,
    }));
    expect(await api.search("")).toEqual([{ id: "a", title: "Q3", updatedAt: "2026-10-30", editUrl: "https://synclo.app/d/a" }]);
  });

  it("refuses to send more than 1 MB", async () => {
    const { api, requests } = client(() => rpcResult({}));
    await expect(api.create({ input: "é".repeat(600_000), mode: "preserve", format: "slides" })).rejects.toMatchObject({ kind: "too-large" });
    expect(requests).toHaveLength(0);
  });

  it("treats a rate limit as a wait", async () => {
    const { api } = client(() => ({ status: 429, headers: { "retry-after": "120" }, body: { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "Too many requests" } } }));
    await expect(api.themes()).rejects.toMatchObject({ kind: "rate-limited", retryAfter: 120 });
  });
});

describe("generations", () => {
  it("asks Synclo to wait, and reads progress", async () => {
    const { api, requests } = client(() =>
      rpcResult({
        id: "gen_1",
        object: "generation",
        status: "running",
        document: null,
        credits: { estimated: 90, used: null, remaining: null },
        warnings: [],
        error: null,
        progress: { step: "writing", title: "Q3 review", slides: [{ title: "Opening", written: true }, { title: "Results", written: false }], written: 1, total: 2, pictures: null },
      }),
    );
    const g = await api.generation("gen_1", 30);
    expect(argsOf(requests[0]!)).toEqual({ generation_id: "gen_1", wait_seconds: 30 });
    expect(requests[0]!.timeoutMs).toBe(60_000);
    expect(g.progress).toEqual({ step: "writing", title: "Q3 review", slides: [{ title: "Opening", written: true }, { title: "Results", written: false }], written: 1, total: 2, pictures: null });
  });

  it("asks again without wait_seconds when a server refuses it", async () => {
    const { api, requests } = client((req) => {
      const args = argsOf(req);
      if ("wait_seconds" in args) return { status: 200, body: { jsonrpc: "2.0", id: 1, error: { code: -32602, message: 'Invalid arguments for get_generation: unknown argument "wait_seconds".' } } };
      return rpcResult({ id: "gen_1", status: "queued" });
    });
    expect((await api.generation("gen_1", 30)).status).toBe("queued");
    await api.generation("gen_1", 30);
    expect(requests.map((r) => "wait_seconds" in argsOf(r))).toEqual([true, false, false]);
  });

  it("names a press for Synclo, and starts it without the name when a server refuses it", async () => {
    const { api, requests } = client((req) => {
      const args = argsOf(req);
      if ("request_id" in args) return { status: 200, body: { jsonrpc: "2.0", id: 1, error: { code: -32602, message: 'Invalid arguments for create_presentation: unknown argument "request_id".' } } };
      return rpcResult({ generation_id: "gen_2", status: "queued" });
    });
    expect((await api.create({ input: "brief", mode: "generate", format: "slides", request_id: "p1" })).generationId).toBe("gen_2");
    await api.create({ input: "brief", mode: "generate", format: "slides", request_id: "p2" });
    expect(requests.map((r) => argsOf(r).request_id ?? null)).toEqual(["p1", null, null]);
  });

  it("hands on a deck started by an answer that came after the wait", async () => {
    const { http } = fakeHttp(() => rpcResult({ generation_id: "gen_3", status: "queued" }));
    // The wait is given up; the answer comes after.
    const lateHttp: typeof http = async (req) => {
      const res = await http(req);
      setTimeout(() => req.late?.(res), 0);
      throw new NetworkError("timed out", true);
    };
    const secrets = memorySecrets();
    secrets.set(SECRET_TOKENS, JSON.stringify({ v: 1, base: BASE, access: "syo_1", refresh: "syr_1", expiresAt: 9_999_999_999_999, scope: "" }));
    const session = new Session({ http: lateHttp, secrets, local: memoryLocal(), crypto: webcrypto as unknown as Crypto, now: () => 0, base: () => BASE });
    const api = new SyncloApi(new McpClient({ http: lateHttp, session, base: () => BASE, now: () => 0 }));
    const late: string[] = [];
    await expect(api.create({ input: "brief", mode: "generate", format: "slides", request_id: "p1" }, (s) => late.push(s.generationId))).rejects.toMatchObject({ kind: "network" });
    await new Promise((r) => setTimeout(r, 0));
    expect(late).toEqual(["gen_3"]);
  });

  it("reads a finished generation", () => {
    const g = parseGeneration({
      id: "gen_1",
      status: "completed",
      document: { id: "0b0e7c39-6f4c-4f53-9d5e-0f6d2f1c9a10", title: "Q3 review", slides: 9, edit_url: "https://synclo.app/d/0b0e7c39-6f4c-4f53-9d5e-0f6d2f1c9a10", share_url: null },
      credits: { estimated: 90, used: 90, remaining: 310 },
      warnings: [],
      error: null,
    });
    expect(g.status).toBe("completed");
    expect(g.document?.editUrl).toBe("https://synclo.app/d/0b0e7c39-6f4c-4f53-9d5e-0f6d2f1c9a10");
    expect(g.credits.remaining).toBe(310);
    expect(parseGeneration({ id: "x", status: "done" }).status).toBe("completed");
  });

  it("finds the presentation id in an editor link", () => {
    expect(documentIdOf("https://synclo.app/d/0B0E7C39-6f4c-4f53-9d5e-0f6d2f1c9a10")).toBe("0b0e7c39-6f4c-4f53-9d5e-0f6d2f1c9a10");
    expect(documentIdOf("http://localhost:3000/d/0b0e7c39-6f4c-4f53-9d5e-0f6d2f1c9a10?x=1")).toBe("0b0e7c39-6f4c-4f53-9d5e-0f6d2f1c9a10");
    expect(documentIdOf("https://synclo.app/r/name-x7Kq9TmA2pD")).toBeNull();
  });
});

describe("pictures", () => {
  it("uploads the raw bytes and returns the address", async () => {
    const { mcp, requests } = client(() => ({ status: 200, body: { url: "https://storage.synclo.app/imports/a.png" } }));
    const url = await mcp.uploadPicture(new Uint8Array([1, 2, 3]).buffer, "image/png");
    expect(url).toBe("https://storage.synclo.app/imports/a.png");
    expect(requests[0]).toMatchObject({ url: "https://synclo.app/mcp/images", method: "POST", contentType: "image/png", headers: { Authorization: "Bearer syo_1" } });
  });

  it("says why a picture was refused", async () => {
    const { mcp } = client(() => ({ status: 415, body: { error: "unsupported_type", error_description: "Send a PNG, JPEG or WebP image." } }));
    await expect(mcp.uploadPicture(new ArrayBuffer(1), "image/png")).rejects.toMatchObject({ kind: "rejected", code: "unsupported_type" });
  });
});
