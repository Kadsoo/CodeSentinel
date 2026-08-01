import { describe, expect, it, vi } from "vitest";
import type {
  AgentSessionController,
  AgentSessionResult,
  ResolvePendingPatchInput,
  StopProbe,
} from "../../core/src/index.js";
import { CodeSentinelCoreError } from "../../core/src/index.js";
import type { HarnessEvent, TaskKind } from "../../contracts/src/index.js";
import type {
  PersistedSession,
  SessionRepository,
} from "../../persistence/src/index.js";
import type { AgentSession } from "../../core/src/index.js";
import type { LoadedWorkspace } from "./workspace-config.js";

const NOW = Date.parse("2026-08-01T00:00:00.000Z");
const WORKSPACE = Object.freeze({
  canonicalRoot: "C:/fixture",
  workspaceId: "workspace-fixture",
  config: Object.freeze({
    providerProfileId: "profile-1",
    allowedPaths: ["src/**"],
    verificationCommands: [
      Object.freeze({
        id: "test",
        launcher: "node_npm_cli" as const,
        args: ["test"],
        timeoutMs: 30_000,
        maxOutputBytes: 4_096,
      }),
    ],
  }),
}) as unknown as LoadedWorkspace;

function session(id: string, state: PersistedSession["state"] = "created"): PersistedSession {
  return Object.freeze({
    id,
    taskKind: "feature_implementation",
    state,
    round: 0,
    workspaceId: WORKSPACE.workspaceId,
    providerId: "profile-1",
    verificationCommandId: "test",
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
  });
}

function repositoryStub(): {
  repository: SessionRepository;
  persisted: Map<string, PersistedSession>;
  createSession: ReturnType<typeof vi.fn>;
  append: ReturnType<typeof vi.fn>;
  loadTimeline: ReturnType<typeof vi.fn>;
  recoverInterruptedSessions: ReturnType<typeof vi.fn>;
} {
  const persisted = new Map<string, PersistedSession>();
  const createSession = vi.fn(async (input: Parameters<SessionRepository["createSession"]>[0]) => {
    persisted.set(input.id, {
      ...session(input.id),
      taskKind: input.taskKind,
      state: input.state,
      round: input.round,
      workspaceId: input.workspaceId,
      providerId: input.providerId,
      verificationCommandId: input.verificationCommandId,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    });
  });
  const append = vi.fn(async (next: HarnessEvent) => {
    const current = persisted.get(next.sessionId);
    if (current !== undefined && next.kind === "state") {
      persisted.set(next.sessionId, {
        ...current,
        state: next.details.state,
        round: next.round,
        updatedAt: next.occurredAt,
      });
    }
  });
  const loadTimeline = vi.fn(async () => [] as readonly HarnessEvent[]);
  const recoverInterruptedSessions = vi.fn(async () => 0);
  const repository = {
    createSession,
    append,
    loadSession: vi.fn(async (id: string) => persisted.get(id)),
    listSessions: vi.fn(async () => [...persisted.values()]),
    loadTimeline,
    recoverInterruptedSessions,
  } as unknown as SessionRepository;
  return { repository, persisted, createSession, append, loadTimeline, recoverInterruptedSessions };
}

function controllerStub(): {
  controller: AgentSessionController;
  runAgentSession: ReturnType<typeof vi.fn>;
  resolvePendingPatch: ReturnType<typeof vi.fn>;
} {
  const runAgentSession = vi.fn(async (input: { session: AgentSession }) => ({
    session: { ...input.session, state: "awaiting_approval" },
    events: [],
  }) as unknown as AgentSessionResult);
  const resolvePendingPatch = vi.fn(async () => ({
    session: { ...session("service-session-1"), state: "completed" },
    events: [],
  }) as unknown as AgentSessionResult);
  return {
    controller: { runAgentSession, resolvePendingPatch },
    runAgentSession,
    resolvePendingPatch,
  };
}

async function serviceWith(overrides: Record<string, unknown> = {}) {
  const module = await import("./index.js");
  const repositoryParts = repositoryStub();
  const controllerParts = controllerStub();
  let stopProbe: StopProbe | undefined;
  const runtimeFactory = vi.fn(async (_input: unknown, deps: { shouldStop: StopProbe }) => {
    void _input;
    stopProbe = deps.shouldStop;
    return {
      workspaceId: WORKSPACE.workspaceId,
      profile: { id: "profile-1", kind: "deepseek" as const, endpoint: "https://example.test", model: "fake", credentialRef: "ref" },
      controller: controllerParts.controller,
    };
  });
  const service = module.createSessionService({
    repository: repositoryParts.repository,
    workspaceLoader: { load: vi.fn(async () => WORKSPACE) },
    runtimeFactory,
    now: () => NOW,
    createId: () => "service-session-1",
    ...overrides,
  });
  return { service, ...repositoryParts, ...controllerParts, runtimeFactory, stopProbe: () => stopProbe };
}

const validRequest = Object.freeze({
  workspacePath: "C:/fixture",
  taskKind: "feature_implementation" as TaskKind,
  verificationCommandId: "test",
  taskSummary: "repair the failing project",
  acceptanceCriteria: "the checks pass",
});

describe("local session service", () => {
  it("persists a created session before launching the background controller", async () => {
    const setup = await serviceWith();
    const accepted = await setup.service.create(validRequest);
    expect(accepted).toMatchObject({ sessionId: "service-session-1", state: "created" });
    expect(setup.createSession.mock.invocationCallOrder[0]).toBeLessThan(
      setup.runAgentSession.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("rejects a second nonterminal session with a stable active-session error", async () => {
    const setup = await serviceWith({
      runtimeFactory: vi.fn(async () => ({
        workspaceId: WORKSPACE.workspaceId,
        profile: { id: "profile-1", kind: "deepseek" as const, endpoint: "https://example.test", model: "fake", credentialRef: "ref" },
        controller: {
          runAgentSession: vi.fn(() => new Promise<AgentSessionResult>(() => undefined)),
          resolvePendingPatch: vi.fn(),
        },
      })),
    });
    await setup.service.create(validRequest);
    await expect(setup.service.create({ ...validRequest, taskSummary: "second" })).rejects.toMatchObject({
      code: "SESSION_ACTIVE",
    });
  });

  it("routes approvals only to the matching active runtime", async () => {
    const setup = await serviceWith();
    await setup.service.create(validRequest);
    await setup.service.resolveApproval({
      sessionId: "service-session-1",
      approvalId: "approval-1",
      decision: "approve",
    } satisfies ResolvePendingPatchInput);
    expect(setup.resolvePendingPatch).toHaveBeenCalledWith({
      sessionId: "service-session-1",
      approvalId: "approval-1",
      decision: "approve",
    });
    await expect(
      setup.service.resolveApproval({ sessionId: "other", approvalId: "approval-1", decision: "approve" }),
    ).rejects.toMatchObject({ code: "SESSION_NOT_ACTIVE" });
  });

  it("keeps an awaiting runtime after a stale approval so a later valid approval can proceed", async () => {
    const resolvePendingPatch = vi
      .fn()
      .mockRejectedValueOnce(new CodeSentinelCoreError("APPROVAL_NOT_FOUND"))
      .mockResolvedValueOnce({
        session: { ...session("service-session-1"), state: "completed" },
        events: [],
      } as unknown as AgentSessionResult);
    const setup = await serviceWith({
      runtimeFactory: vi.fn(async () => ({
        workspaceId: WORKSPACE.workspaceId,
        profile: { id: "profile-1", kind: "deepseek" as const, endpoint: "https://example.test", model: "fake", credentialRef: "ref" },
        controller: {
          runAgentSession: vi.fn(async (input: { session: AgentSession }) => ({
            session: { ...input.session, state: "awaiting_approval" },
            events: [],
          }) as unknown as AgentSessionResult),
          resolvePendingPatch,
        },
      })),
    });
    await setup.service.create(validRequest);
    await expect(
      setup.service.resolveApproval({ sessionId: "service-session-1", approvalId: "stale", decision: "approve" }),
    ).rejects.toMatchObject({ code: "APPROVAL_NOT_FOUND" });
    await setup.service.resolveApproval({
      sessionId: "service-session-1",
      approvalId: "valid",
      decision: "approve",
    });
    expect(resolvePendingPatch).toHaveBeenCalledTimes(2);
  });

  it("persists a failed terminal state before dropping a runtime on non-Core approval failure", async () => {
    const resolvePendingPatch = vi.fn().mockRejectedValueOnce(new Error("controller failed"));
    const setup = await serviceWith({
      runtimeFactory: vi.fn(async () => ({
        workspaceId: WORKSPACE.workspaceId,
        profile: { id: "profile-1", kind: "deepseek" as const, endpoint: "https://example.test", model: "fake", credentialRef: "ref" },
        controller: {
          runAgentSession: vi.fn(async (input: { session: AgentSession }) => ({
            session: { ...input.session, state: "awaiting_approval" },
            events: [],
          }) as unknown as AgentSessionResult),
          resolvePendingPatch,
        },
      })),
    });
    await setup.service.create(validRequest);
    await expect(
      setup.service.resolveApproval({ sessionId: "service-session-1", approvalId: "approval-1", decision: "approve" }),
    ).rejects.toMatchObject({ code: "STATE_UNAVAILABLE" });
    expect(setup.append).toHaveBeenCalledWith(expect.objectContaining({
      kind: "state",
      summary: "APPROVAL_FAILED",
      details: { state: "failed" },
    }));
    await expect(setup.service.get("service-session-1")).resolves.toMatchObject({ state: "failed" });
    await expect(setup.service.stop({ sessionId: "service-session-1" })).resolves.toBe("already_stopped");
  });

  it("passes bounded read limits through to persistence", async () => {
    const setup = await serviceWith();
    await setup.service.list(7);
    await setup.service.timeline("service-session-1", 11);
    expect((setup.repository.listSessions as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith({ limit: 7 });
    expect(setup.loadTimeline).toHaveBeenCalledWith("service-session-1", { limit: 11 });
  });

  it("recovers interrupted persisted sessions before creating a new one", async () => {
    const setup = await serviceWith();
    await setup.service.create(validRequest);
    expect(setup.recoverInterruptedSessions).toHaveBeenCalled();
    expect(setup.recoverInterruptedSessions.mock.invocationCallOrder[0]).toBeLessThan(
      setup.createSession.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("sets a cooperative stop probe for a running session and makes repeat stops idempotent", async () => {
    const setup = await serviceWith({
      runtimeFactory: vi.fn(async (_input: unknown, deps: { shouldStop: StopProbe }) => {
        void _input;
        setupStopProbe = deps.shouldStop;
        return {
          workspaceId: WORKSPACE.workspaceId,
          profile: { id: "profile-1", kind: "deepseek" as const, endpoint: "https://example.test", model: "fake", credentialRef: "ref" },
          controller: {
            runAgentSession: vi.fn(() => new Promise<AgentSessionResult>(() => undefined)),
            resolvePendingPatch: vi.fn(),
          },
        };
      }),
    });
    let setupStopProbe: StopProbe | undefined;
    await setup.service.create(validRequest);
    expect(await setup.service.stop({ sessionId: "service-session-1" })).toBe("accepted");
    expect(setupStopProbe?.("service-session-1")).toBe(true);
    expect(await setup.service.stop({ sessionId: "service-session-1" })).toBe("already_stopped");
    expect(setup.append).not.toHaveBeenCalled();
  });

  it("writes one stopped event and removes an awaiting-approval runtime immediately", async () => {
    const setup = await serviceWith({
      runtimeFactory: vi.fn(async () => {
        return {
          workspaceId: WORKSPACE.workspaceId,
          profile: { id: "profile-1", kind: "deepseek" as const, endpoint: "https://example.test", model: "fake", credentialRef: "ref" },
          controller: {
            runAgentSession: vi.fn(async (input: { session: AgentSession }) => ({
              session: { ...input.session, state: "awaiting_approval" },
              events: [],
            }) as unknown as AgentSessionResult),
            resolvePendingPatch: vi.fn(),
          },
        };
      }),
    });
    await setup.service.create(validRequest);
    expect(await setup.service.stop({ sessionId: "service-session-1" })).toBe("accepted");
    expect(setup.append).toHaveBeenCalledTimes(1);
    expect(setup.append).toHaveBeenCalledWith(expect.objectContaining({
      kind: "state",
      details: { state: "stopped" },
    }));
    expect(await setup.service.stop({ sessionId: "service-session-1" })).toBe("already_stopped");
    expect(setup.append).toHaveBeenCalledTimes(1);
  });

  it("rolls back an awaiting stop flag when persistence fails so a retry can stop once", async () => {
    const setup = await serviceWith();
    await setup.service.create(validRequest);
    setup.append.mockRejectedValueOnce(new Error("persistence unavailable"));
    await expect(setup.service.stop({ sessionId: "service-session-1" })).rejects.toMatchObject({
      code: "STATE_UNAVAILABLE",
    });
    expect(await setup.service.stop({ sessionId: "service-session-1" })).toBe("accepted");
    expect(setup.append).toHaveBeenCalledTimes(2);
    expect(await setup.service.stop({ sessionId: "service-session-1" })).toBe("already_stopped");
  });

  it("lets a concurrent stop request set the probe while approval is in flight", async () => {
    let releaseApproval!: (result: AgentSessionResult) => void;
    let stopProbe: StopProbe | undefined;
    const resolvePendingPatch = vi.fn(() => new Promise<AgentSessionResult>((resolve) => {
      releaseApproval = resolve;
    }));
    const setup = await serviceWith({
      runtimeFactory: vi.fn(async (_input: unknown, dependencies: { shouldStop: StopProbe }) => {
        void _input;
        stopProbe = dependencies.shouldStop;
        return {
          workspaceId: WORKSPACE.workspaceId,
          profile: { id: "profile-1", kind: "deepseek" as const, endpoint: "https://example.test", model: "fake", credentialRef: "ref" },
          controller: {
            runAgentSession: vi.fn(async (input: { session: AgentSession }) => ({
              session: { ...input.session, state: "awaiting_approval" },
              events: [],
            }) as unknown as AgentSessionResult),
            resolvePendingPatch,
          },
        };
      }),
    });
    await setup.service.create(validRequest);
    const approvalPromise = setup.service.resolveApproval({
      sessionId: "service-session-1",
      approvalId: "approval-1",
      decision: "approve",
    });
    await vi.waitFor(() => expect(resolvePendingPatch).toHaveBeenCalledTimes(1));
    await expect(setup.service.stop({ sessionId: "service-session-1" })).resolves.toBe("accepted");
    expect(stopProbe?.("service-session-1")).toBe(true);
    releaseApproval({
      session: { ...session("service-session-1"), state: "stopped" },
      events: [],
    } as unknown as AgentSessionResult);
    await approvalPromise;
    await expect(setup.service.stop({ sessionId: "service-session-1" })).rejects.toMatchObject({
      code: "SESSION_NOT_ACTIVE",
    });
  });

  it("allows retrying stop when concurrent approval failure cannot persist its terminal state", async () => {
    let rejectApproval!: (error: Error) => void;
    const resolvePendingPatch = vi.fn(() => new Promise<AgentSessionResult>((_resolve, reject) => {
      rejectApproval = reject;
    }));
    const setup = await serviceWith({
      runtimeFactory: vi.fn(async () => ({
        workspaceId: WORKSPACE.workspaceId,
        profile: { id: "profile-1", kind: "deepseek" as const, endpoint: "https://example.test", model: "fake", credentialRef: "ref" },
        controller: {
          runAgentSession: vi.fn(async (input: { session: AgentSession }) => ({
            session: { ...input.session, state: "awaiting_approval" },
            events: [],
          }) as unknown as AgentSessionResult),
          resolvePendingPatch,
        },
      })),
    });
    await setup.service.create(validRequest);
    const approvalPromise = setup.service.resolveApproval({
      sessionId: "service-session-1",
      approvalId: "approval-1",
      decision: "approve",
    });
    await vi.waitFor(() => expect(resolvePendingPatch).toHaveBeenCalledTimes(1));
    await expect(setup.service.stop({ sessionId: "service-session-1" })).resolves.toBe("accepted");
    setup.append.mockRejectedValueOnce(new Error("persistence unavailable"));
    rejectApproval(new Error("controller failed"));
    await expect(approvalPromise).rejects.toMatchObject({ code: "STATE_UNAVAILABLE" });
    expect(await setup.service.stop({ sessionId: "service-session-1" })).toBe("accepted");
  });
});
