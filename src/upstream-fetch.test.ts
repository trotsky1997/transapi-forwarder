import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { createKeepAliveFetch, type KeepAliveFetch } from "./upstream-fetch";

const cleanupTasks: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanupTasks.length > 0) {
    const task = cleanupTasks.pop();
    if (task) {
      await task();
    }
  }
});

describe("createKeepAliveFetch", () => {
  test("reuses an upstream socket across sequential requests", async () => {
    const sockets = new Set<unknown>();

    const server = createServer((request, response) => {
      sockets.add(request.socket);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true }));
    }) as any;

    await new Promise<void>((resolvePromise) => {
      server.listen(0, "127.0.0.1", () => resolvePromise());
    });

    cleanupTasks.push(
      () =>
        new Promise<void>((resolvePromise) => {
          server.close(() => resolvePromise());
        })
    );

    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const baseUrl = `http://127.0.0.1:${port}/ping`;

    const pooledFetch = createKeepAliveFetch() as KeepAliveFetch;
    cleanupTasks.push(() => pooledFetch.close());

    const first = await pooledFetch(baseUrl);
    expect(await first.json()).toEqual({ ok: true });

    const second = await pooledFetch(baseUrl);
    expect(await second.json()).toEqual({ ok: true });

    expect(sockets.size).toBe(1);
  });
});
