import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { runCli, type CliOutput } from "../../cli/src/credentials.js";
import { buildServer } from "./server.js";
import {
  createProfileStore,
  createSessionService,
  createWorkspaceConfigLoader,
  createWorkspaceRuntime,
  type SessionRuntimeFactory,
} from "../../../packages/host/src/index.js";
import { createSessionRepository } from "../../../packages/persistence/src/index.js";
import { InMemoryCredentialStore, type Provider } from "../../../packages/providers/src/index.js";

const SECRET = "sk-task10-secret-sentinel-20260801";
const NOW = Date.parse("2026-08-01T00:00:00.000Z");

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve(value: T): void;
}>;

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return Object.freeze({ promise, resolve: resolvePromise });
}

function capturedOutput(): CliOutput & { text(): string } {
  let value = "";
  return {
    write(chunk: string | Uint8Array): boolean {
      value += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    },
    text: () => value,
  };
}

async function readStateBytes(stateDirectory: string): Promise<string> {
  const names = await readdir(stateDirectory);
  const files = await Promise.all(
    names.map(async (name) => {
      const path = join(stateDirectory, name);
      const bytes = await readFile(path);
      return bytes.toString("utf8");
    }),
  );
  return files.join("\n");
}

describe("Task 10 cross-component local API integration", () => {
  it("starts through HTTP, persists redacted events, stops once, and keeps secrets out of local outputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "codesentinel-task10-integration-"));
    const workspacePath = join(root, "workspace");
    const stateDirectory = join(root, "state");
    const sessionsPath = join(stateDirectory, "sessions.sqlite");
    await mkdir(stateDirectory, { recursive: true });
    const profileStore = createProfileStore({ stateDirectory });
    const credentialStore = new InMemoryCredentialStore();
    const repository = createSessionRepository(sessionsPath);
    const providerCalls: Promise<void>[] = [];
    const releaseProvider = deferred<unknown>();
    let providerCallCount = 0;
    const provider: Provider = {
      complete: vi.fn(async () => {
        providerCallCount += 1;
        providerCalls.push(Promise.resolve());
        return releaseProvider.promise;
      }),
    };
    const runtimeFactory: SessionRuntimeFactory = (input, runtimeDependencies) =>
      createWorkspaceRuntime(input, {
        profileStore,
        credentialStore,
        repository,
        now: () => NOW,
        createId: (() => {
          let next = 0;
          return () => `integration-id-${++next}`;
        })(),
        shouldStop: runtimeDependencies.shouldStop,
        providerFactory: () => provider,
      });
    let app: FastifyInstance | undefined;

    try {
      await mkdir(workspacePath, { recursive: true });
      await writeFile(
        join(workspacePath, "package.json"),
        JSON.stringify({
          private: true,
          scripts: { test: `node -e "console.log('${SECRET}'); process.exit(1)"` },
        }),
        "utf8",
      );
      await writeFile(
        join(workspacePath, "codesentinel.json"),
        JSON.stringify({
          providerProfileId: "integration-profile",
          allowedPaths: ["src/**"],
          verificationCommands: [
            {
              id: "test",
              launcher: "node_npm_cli",
              args: ["test"],
              timeoutMs: 10_000,
              maxOutputBytes: 8_192,
            },
          ],
        }),
        "utf8",
      );
      await profileStore.upsert({
        id: "integration-profile",
        kind: "deepseek",
        endpoint: "https://api.deepseek.com/chat/completions",
        model: "deepseek-v4-flash",
        credentialRef: "integration-profile",
      });

      const workspaceLoader = createWorkspaceConfigLoader();
      const service = createSessionService({
        repository,
        workspaceLoader,
        profileStore,
        credentialStore,
        now: () => NOW,
        createId: (() => {
          let next = 0;
          return () => `session-${++next}`;
        })(),
        runtimeFactory,
      });
      app = buildServer({ workspaceLoader, sessionService: service, profileStore, credentialStore });

      const cliOutput = capturedOutput();
      const cliResult = await runCli(
        [
          "credentials",
          "set",
          "integration-profile",
          "--provider",
          "deepseek",
          "--model",
          "deepseek-v4-flash",
        ],
        {
          profileStore,
          credentialStore,
          streams: { stdout: cliOutput, stderr: cliOutput, stdin: { isTTY: true } },
          promptHidden: async () => SECRET,
        },
      );
      expect(cliResult).toBe(0);
      expect(cliOutput.text()).not.toContain(SECRET);
      const cliStatus = await runCli(["credentials", "status", "integration-profile"], {
        profileStore,
        credentialStore,
        streams: { stdout: cliOutput, stderr: cliOutput, stdin: { isTTY: true } },
      });
      expect(cliStatus).toBe(0);
      expect(cliOutput.text()).not.toContain(SECRET);

      const credentialResponse = await app.inject({
        method: "PUT",
        url: "/credentials/integration-profile",
        payload: { secret: SECRET },
      });
      expect(credentialResponse.statusCode).toBe(204);
      expect(credentialResponse.body).toBe("");
      expect(credentialResponse.body).not.toContain(SECRET);

      const createResponse = await app.inject({
        method: "POST",
        url: "/sessions",
        payload: {
          workspacePath,
          taskKind: "test_repair",
          verificationCommandId: "test",
          taskSummary: `implement safely ${SECRET}`,
        },
      });
      expect(createResponse.statusCode).toBe(202);
      expect(createResponse.body).not.toContain(SECRET);
      const created = createResponse.json() as { sessionId: string };

      await vi.waitFor(() => expect(providerCallCount).toBeGreaterThanOrEqual(1));
      const concurrentResponse = await app.inject({
        method: "POST",
        url: "/sessions",
        payload: {
          workspacePath,
          taskKind: "test_repair",
          verificationCommandId: "test",
          taskSummary: "concurrent request",
        },
      });
      expect(concurrentResponse.statusCode).toBe(409);
      expect(concurrentResponse.json()).toEqual({ code: "SESSION_ACTIVE" });
      expect(concurrentResponse.body).not.toContain(SECRET);

      const stopResponse = await app.inject({
        method: "POST",
        url: `/sessions/${created.sessionId}/stop`,
      });
      expect(stopResponse.statusCode).toBe(200);
      expect(stopResponse.json()).toEqual({ status: "accepted" });
      expect(stopResponse.body).not.toContain(SECRET);
      releaseProvider.resolve({ kind: "finish", outcome: "completed", summary: SECRET });
      await vi.waitFor(async () => {
        await expect(service.get(created.sessionId)).resolves.toMatchObject({ state: "stopped" });
      });

      const repeatStopResponse = await app.inject({
        method: "POST",
        url: `/sessions/${created.sessionId}/stop`,
      });
      expect(repeatStopResponse.statusCode).toBe(200);
      expect(repeatStopResponse.json()).toEqual({ status: "already_stopped" });

      const timelineResponse = await app.inject({
        method: "GET",
        url: `/sessions/${created.sessionId}/timeline?limit=500`,
      });
      expect(timelineResponse.statusCode).toBe(200);
      expect(timelineResponse.body).not.toContain(SECRET);
      expect(timelineResponse.body).toContain("[REDACTED]");
      const persistedTimeline = await repository.loadTimeline(created.sessionId, { limit: 500 });
      expect(persistedTimeline.some((event) => event.summary.includes("[REDACTED]"))).toBe(true);
      expect(persistedTimeline.every((event) => !event.summary.includes(SECRET))).toBe(true);
      expect(await readStateBytes(stateDirectory)).not.toContain(SECRET);
      expect((await readdir(stateDirectory)).some((name) => name === "profiles.json")).toBe(true);
      expect((await readdir(stateDirectory)).some((name) => name === "sessions.sqlite")).toBe(true);
      expect(providerCalls).toHaveLength(1);

      await app.close();
    } finally {
      releaseProvider.resolve({ kind: "finish", outcome: "completed", summary: SECRET });
      await app?.close();
      repository.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
