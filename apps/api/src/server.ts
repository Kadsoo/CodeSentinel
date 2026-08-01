import Fastify, { type FastifyInstance } from "fastify";
import { installErrorHandler, registerRoutes, type ApiDependencies } from "./routes.js";

export const LOOPBACK_HOST = "127.0.0.1" as const;
export const LOOPBACK_PORT = 48_761 as const;
export const API_BODY_LIMIT_BYTES = 16 * 1024;

export type ServerAddress = Readonly<{
  host: typeof LOOPBACK_HOST;
  port: typeof LOOPBACK_PORT;
}>;

export type ServerStartOptions = Readonly<{
  listen?: (address: ServerAddress) => Promise<unknown>;
}>;

export type ServerErrorCode = "SERVER_ALREADY_RUNNING";

export class ServerError extends Error {
  readonly code: ServerErrorCode;

  constructor(code: ServerErrorCode) {
    super(code);
    this.name = "ServerError";
    this.code = code;
    Object.defineProperty(this, "code", {
      value: code,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
}

export function buildServer(dependencies: ApiDependencies): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: API_BODY_LIMIT_BYTES });
  registerRoutes(app, dependencies);
  installErrorHandler(app);
  return app;
}

export async function startServer(
  dependencies: ApiDependencies,
  options: ServerStartOptions = {},
): Promise<FastifyInstance> {
  const app = buildServer(dependencies);
  const address: ServerAddress = Object.freeze({
    host: LOOPBACK_HOST,
    port: LOOPBACK_PORT,
  });
  try {
    await dependencies.sessionService.recover();
    if (options.listen !== undefined) {
      await options.listen(address);
    } else {
      await app.listen(address);
    }
    return app;
  } catch (error) {
    await app.close().catch(() => undefined);
    if (isAddressInUse(error)) {
      throw new ServerError("SERVER_ALREADY_RUNNING");
    }
    throw error;
  }
}

function isAddressInUse(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  return (error as { code?: unknown }).code === "EADDRINUSE";
}

export type { ApiDependencies } from "./routes.js";
