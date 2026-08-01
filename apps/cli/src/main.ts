import { homedir } from "node:os";
import { join } from "node:path";
import { createProfileStore } from "../../../packages/host/src/profile-store.js";
import { createWorkspaceConfigLoader } from "../../../packages/host/src/workspace-config.js";
import { createSessionService } from "../../../packages/host/src/session-service.js";
import { createSessionRepository } from "../../../packages/persistence/src/index.js";
import {
  OpenAICompatibleProvider,
  probeProvider,
  WindowsCredentialStore,
  type CredentialStore,
  type KeytarLike,
} from "../../../packages/providers/src/index.js";
import { startServer } from "../../api/src/server.js";
import {
  runCli as dispatchCli,
  type CliDependencies,
  type CliStreams,
} from "./credentials.js";

export { dispatchCli as runCli };
export type { CliDependencies, CliStreams } from "./credentials.js";

/**
 * Production entrypoint. Credential Manager is loaded only after a command
 * explicitly requests credentials or the local session server. Importing the
 * CLI module itself remains side-effect free and test-safe.
 */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  try {
    const dependencies = await createProductionDependencies(argv);
    return await dispatchCli(argv, dependencies);
  } catch (error) {
    const streams = productionStreams();
    streams.stderr.write(`${stableErrorCode(error)}\n`);
    return 1;
  }
}

async function createProductionDependencies(argv: readonly string[]): Promise<CliDependencies> {
  const stateDirectory = localStateDirectory();
  const profileStore = createProfileStore({ stateDirectory });
  if (!requiresNativeCredentialStore(argv)) {
    return {
      profileStore,
      credentialStore: unavailableCredentialStore(),
      streams: productionStreams(),
    };
  }
  // A credentials command and the server are explicit local operations. Only
  // this path performs the dynamic native Credential Manager load.
  const credentialStore = await loadCredentialStore();
  const streams = productionStreams();
  return {
    profileStore,
    credentialStore,
    streams,
    promptHidden: () => promptHidden(streams),
    probe: async (profile, secret) => {
      const provider = new OpenAICompatibleProvider({
        endpoint: profile.endpoint,
        model: profile.model,
        apiKey: secret,
        fetch: globalThis.fetch,
      });
      await probeProvider(provider);
    },
    start: async () => {
      const repository = createSessionRepository(join(stateDirectory, "sessions.sqlite"));
      const sessionService = createSessionService({
        repository,
        profileStore,
        credentialStore,
      });
      await startServer({
        workspaceLoader: createWorkspaceConfigLoader(),
        sessionService,
        profileStore,
        credentialStore,
      });
    },
  };
}

function requiresNativeCredentialStore(argv: readonly string[]): boolean {
  if (argv.includes("--help") || argv.includes("-h")) {
    return false;
  }
  return argv[0] === "start" || argv[0] === "credentials";
}

function unavailableCredentialStore(): CredentialStore {
  const unavailable = async (): Promise<never> => {
    throw new CliFailure("CREDENTIAL_UNAVAILABLE");
  };
  return {
    set: unavailable,
    get: unavailable,
    status: unavailable,
    clear: unavailable,
  };
}

async function loadCredentialStore(): Promise<CredentialStore> {
  try {
    const module = (await import("keytar")) as unknown as {
      default?: KeytarLike;
      getPassword?: KeytarLike["getPassword"];
      setPassword?: KeytarLike["setPassword"];
      deletePassword?: KeytarLike["deletePassword"];
    };
    const keytar = module.default ?? module;
    if (
      typeof keytar.getPassword !== "function" ||
      typeof keytar.setPassword !== "function" ||
      typeof keytar.deletePassword !== "function"
    ) {
      throw new Error("credential manager unavailable");
    }
    return new WindowsCredentialStore(keytar as KeytarLike);
  } catch {
    // Keep native details out of the terminal and preserve the stable contract.
    throw new CliFailure("CREDENTIAL_UNAVAILABLE");
  }
}

function localStateDirectory(): string {
  const localAppData = process.env.LOCALAPPDATA;
  return localAppData === undefined || localAppData.trim().length === 0
    ? join(homedir(), "AppData", "Local", "Kadsoo", "CodeSentinel")
    : join(localAppData, "Kadsoo", "CodeSentinel");
}

function productionStreams(): CliStreams {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
  };
}

async function promptHidden(streams: CliStreams): Promise<string> {
  if (streams.stdin.isTTY !== true) {
    throw new CliFailure("CREDENTIAL_UNAVAILABLE");
  }
  // Raw terminal mode disables character echo. The injected prompt port used
  // by tests never reaches this branch, so test runs do not touch stdin.
  const input = streams.stdin as CliHiddenInput;
  if (
    typeof input.setRawMode !== "function" ||
    typeof input.on !== "function" ||
    typeof input.removeListener !== "function"
  ) {
    throw new CliFailure("CREDENTIAL_UNAVAILABLE");
  }
  streams.stderr.write("API key: ");
  const wasRaw = input.isRaw === true;
  input.setRawMode(true);
  input.resume?.();
  return new Promise<string>((resolve, reject) => {
    let contents = "";
    const onData = (chunk: string | Uint8Array): void => {
      const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      if (text.includes("\u0003")) {
        finish(new CliFailure("CREDENTIAL_UNAVAILABLE"));
        return;
      }
      const lineEnd = text.search(/[\r\n]/u);
      if (lineEnd === -1) {
        contents += text;
        return;
      }
      contents += text.slice(0, lineEnd);
      finish(undefined, contents);
    };
    const finish = (error: CliFailure | undefined, secret?: string): void => {
      input.removeListener?.("data", onData);
      input.setRawMode?.(wasRaw);
      input.pause?.();
      streams.stderr.write("\n");
      if (error !== undefined) {
        reject(error);
      } else {
        resolve(secret ?? "");
      }
    };
    input.on?.("data", onData);
  });
}

type CliHiddenInput = CliStreams["stdin"] & {
  readonly isRaw?: boolean;
  setRawMode?(mode: boolean): CliHiddenInput;
  resume?(): CliHiddenInput;
  pause?(): CliHiddenInput;
  on?(event: "data", listener: (chunk: string | Uint8Array) => void): CliHiddenInput;
  removeListener?(event: "data", listener: (chunk: string | Uint8Array) => void): CliHiddenInput;
};

function stableErrorCode(error: unknown): string {
  if (error instanceof CliFailure) {
    return error.code;
  }
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0 && !code.includes(" ")) {
      return code;
    }
  }
  return "INTERNAL_ERROR";
}

class CliFailure extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

if (process.argv[1] !== undefined && process.argv[1].endsWith("apps/cli/src/main.ts")) {
  void main().then((code) => {
    if (code !== 0) {
      process.exitCode = code;
    }
  });
}
