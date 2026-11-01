import { requestUrl, type RequestUrlResponse } from "obsidian";
import { NetworkError, type Http, type HttpResponse } from "../api/http";

/**
 * Http on Obsidian's requestUrl, which works on desktop and mobile and is
 * not bound by the browser's cross-origin rules. requestUrl has no timeout
 * and can't be stopped, so the wait is bounded here and a late answer is
 * dropped.
 */
function toResponse(res: RequestUrlResponse): HttpResponse {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.headers ?? {})) headers[k.toLowerCase()] = v;
  return { status: res.status, headers, text: () => res.text, arrayBuffer: () => res.arrayBuffer };
}

export function obsidianHttp(): Http {
  return async (req) => {
    let timer: number | undefined;
    let gaveUp = false;
    const request = requestUrl({ url: req.url, method: req.method, headers: req.headers, body: req.body, contentType: req.contentType, throw: false });
    // An answer that arrives after the wait is over is handed to `late`
    // when the caller wants it, else ignored; never thrown.
    request.then(
      (res) => {
        if (gaveUp) req.late?.(toResponse(res));
      },
      () => undefined,
    );
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = window.setTimeout(() => {
        gaveUp = true;
        reject(new NetworkError("Synclo took too long to answer.", true));
      }, req.timeoutMs);
    });
    try {
      return toResponse(await Promise.race([request, timeout]));
    } catch (err) {
      if (err instanceof NetworkError) throw err;
      throw new NetworkError(err instanceof Error ? err.message : "The request failed.", false);
    } finally {
      window.clearTimeout(timer);
    }
  };
}
