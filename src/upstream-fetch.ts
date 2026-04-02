import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { Readable } from "node:stream";

export interface KeepAliveFetchOptions {
  keepAliveMsecs?: number;
  maxSockets?: number;
  maxFreeSockets?: number;
  timeoutMs?: number;
}

export type KeepAliveFetch = typeof globalThis.fetch & { close(): void };

function headersFromIncomingMessage(response: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(response.headers)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
      continue;
    }
    headers.set(key, value);
  }
  return headers;
}

export function createKeepAliveFetch(options: KeepAliveFetchOptions = {}): KeepAliveFetch {
  const httpAgent = new HttpAgent({
    keepAlive: true,
    keepAliveMsecs: options.keepAliveMsecs ?? 1_000,
    maxSockets: options.maxSockets ?? 128,
    maxFreeSockets: options.maxFreeSockets ?? 16,
  });
  const httpsAgent = new HttpsAgent({
    keepAlive: true,
    keepAliveMsecs: options.keepAliveMsecs ?? 1_000,
    maxSockets: options.maxSockets ?? 128,
    maxFreeSockets: options.maxFreeSockets ?? 16,
  });

  const pooledFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
    const agent = url.protocol === "https:" ? httpsAgent : httpAgent;
    const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;

    return new Promise<Response>((resolvePromise, rejectPromise) => {
      const upstreamRequest = transport(
        url,
        {
          method: request.method,
          headers: Object.fromEntries(request.headers.entries()),
          agent,
        },
        (upstreamResponse) => {
          request.signal.removeEventListener("abort", abort);
          const headers = headersFromIncomingMessage(upstreamResponse);
          const status = upstreamResponse.statusCode ?? 500;
          const statusText = upstreamResponse.statusMessage ?? "";
          const isBodyless = request.method === "HEAD" || status === 204 || status === 304;
          const responseBody = isBodyless ? null : (Readable.toWeb(upstreamResponse as never) as never);

          resolvePromise(
            new Response(responseBody, {
              status,
              statusText,
              headers,
            })
          );
        }
      );

      const abort = () => {
        upstreamRequest.destroy(new Error("The operation was aborted"));
      };

      if (request.signal.aborted) {
        abort();
        return;
      }

      request.signal.addEventListener("abort", abort, { once: true });
      upstreamRequest.on("error", (error) => {
        request.signal.removeEventListener("abort", abort);
        rejectPromise(error);
      });

      if (options.timeoutMs !== undefined) {
        upstreamRequest.setTimeout(options.timeoutMs, () => {
          upstreamRequest.destroy(new Error(`Upstream request timed out after ${options.timeoutMs}ms`));
        });
      }

      if (body && body.length > 0) {
        upstreamRequest.write(body);
      }
      upstreamRequest.end();
    });
  }) as KeepAliveFetch;

  pooledFetch.close = () => {
    httpAgent.destroy();
    httpsAgent.destroy();
  };

  return pooledFetch;
}
