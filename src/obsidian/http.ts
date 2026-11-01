import { requestUrl } from "obsidian";
import { NetworkError, type Http } from "../api/http";

/**
 * Http on Obsidian's requestUrl, which works on desktop and mobile and is
 * not bound by the browser's cross-origin rules. requestUrl has no timeout
 * and can't be stopped, so the wait is bounded here and a late answer is
 * dropped.
 */
export function obsidianHttp(): Http {
  return async (req) => {
    let timer: number | undefined;
    const request = requestUrl({ url: req.url, method: req.method, headers: req.headers, body: req.body, contentType: req.contentType, throw: false });
    // An answer that arrives after the wait is over is ignored, never thrown.
    request.catch(() => undefined);
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = window.setTimeout(() => reject(new NetworkError("Synclo took too long to answer.", true)), req.timeoutMs);
    });
    try {
      const res = await Promise.race([request, timeout]);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers ?? {})) headers[k.toLowerCase()] = v;
      return { status: res.status, headers, text: () => res.text, arrayBuffer: () => res.arrayBuffer };
    } catch (err) {
      if (err instanceof NetworkError) throw err;
      throw new NetworkError(err instanceof Error ? err.message : "The request failed.", false);
    } finally {
      window.clearTimeout(timer);
    }
  };
}
