declare module "node:fs/promises" {
  export function readFile(path: string, encoding: string): Promise<string>;
}

declare module "node:path" {
  export function resolve(...paths: string[]): string;
}

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
}

declare module "node:stream" {
  export class Readable {
    static fromWeb(stream: ReadableStream<Uint8Array>): { pipe(target: unknown): unknown };
    static toWeb(stream: unknown): ReadableStream<Uint8Array>;
  }
}

declare module "node:http" {
  export interface IncomingMessage extends AsyncIterable<Uint8Array> {
    method?: string;
    url?: string;
    headers: Record<string, string | string[] | undefined>;
    statusCode?: number;
    statusMessage?: string;
    socket: { encrypted?: boolean };
  }

  export interface ClientRequest {
    write(chunk: Uint8Array): void;
    end(): void;
    setTimeout(timeoutMs: number, callback: () => void): void;
    destroy(error?: Error): void;
    on(event: "error", listener: (error: Error) => void): this;
  }

  export class Agent {
    constructor(options?: {
      keepAlive?: boolean;
      keepAliveMsecs?: number;
      maxSockets?: number;
      maxFreeSockets?: number;
    });
    destroy(): void;
  }

  export interface ServerResponse {
    statusCode: number;
    statusMessage: string;
    setHeader(name: string, value: string): void;
    end(chunk?: string): void;
    on(event: "finish" | "error", listener: (error?: unknown) => void): this;
  }

  export interface Server {
    listen(port: number, host: string, callback: () => void): this;
    once(event: "error", listener: (error: unknown) => void): this;
    off(event: "error", listener: (error: unknown) => void): this;
    close(callback: () => void): this;
  }

  export function createServer(
    handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
  ): Server;

  export function request(
    url: URL,
    options: {
      method?: string;
      headers?: Record<string, string>;
      agent?: Agent;
    },
    callback: (response: IncomingMessage) => void
  ): ClientRequest;
}

declare module "node:https" {
  export { Agent, IncomingMessage, ClientRequest } from "node:http";
  export function request(
    url: URL,
    options: {
      method?: string;
      headers?: Record<string, string>;
      agent?: import("node:http").Agent;
    },
    callback: (response: import("node:http").IncomingMessage) => void
  ): import("node:http").ClientRequest;
}

declare const process: {
  env: Record<string, string | undefined>;
  argv: string[];
  on(event: "SIGINT" | "SIGTERM", listener: () => void): void;
  exit(code?: number): never;
};

declare class Buffer extends Uint8Array {
  static from(value: string | ArrayBuffer | ArrayBufferView): Buffer;
  static concat(values: readonly Uint8Array[]): Buffer;
  static isBuffer(value: unknown): value is Buffer;
  readonly length: number;
}
