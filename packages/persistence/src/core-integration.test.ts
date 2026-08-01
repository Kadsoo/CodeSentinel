import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { EventSink } from "../../contracts/src/index.js";
import { createAgentSessionController, type AgentSession } from "../../core/src/index.js";
import {
  askForPatchPolicy,
  fakeTools,
} from "../../core/src/test-support.js";
import { ScriptedMockProvider } from "../../providers/src/index.js";
import { createSessionRepository } from "./index.js";

const START_TIME = Date.parse("2026-07-30T00:00:00.000Z");

async function withDatabasePath<T>(
  callback: (databasePath: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "codesentinel-core-integration-"));
  try {
    return await callback(join(directory, "sessions.sqlite"));
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

function sequenceValues<T>(values: readonly T[]): () => T {
  let index = 0;
  return () => {
    const value = values[index];
    if (value === undefined) {
      throw new Error("deterministic sequence exhausted");
    }
    index += 1;
    return value;
  };
}

describe("persistence Core integration", () => {
  it("persists one deterministic approved repair through EventSink without raw payloads", async () => {
    await withDatabasePath(async (databasePath) => {
      const taskSentinel = "sk-proj-task-summary-sentinel-1001";
      const pathSentinel = "sk-proj-provider-path-sentinel-1002";
      const reasonSentinel = "sk-proj-provider-reason-sentinel-1003";
      const patchSentinel = "sk-proj-provider-patch-sentinel-1004";
      const toolSentinel = "sk-proj-fake-tool-output-sentinel-1005";
      const initialVerificationSentinel = "sk-proj-initial-verification-sentinel-1006";
      const finalVerificationSentinel = "sk-proj-final-verification-sentinel-1007";
      const sentinels = [
        taskSentinel,
        pathSentinel,
        reasonSentinel,
        patchSentinel,
        toolSentinel,
        initialVerificationSentinel,
        finalVerificationSentinel,
      ];
      const rawPatch = `@@ -1 +1 @@\n-before\n+after-${patchSentinel}\n`;
      const actionId = "core-action-1";
      const approvalId = "core-approval-1";
      const session: AgentSession = Object.freeze({
        id: "core-integration-session-1",
        taskKind: "test_repair",
        state: "created",
        round: 0,
        workspaceId: "workspace-1",
        providerId: "mock-provider-1",
        verificationCommandId: "test",
        taskSummary: `repair the selected test ${taskSentinel}`,
      });
      const provider = new ScriptedMockProvider([
        {
          kind: "propose_patch",
          stage: "repair",
          path: `src/${pathSentinel}.ts`,
          baseHash: "a".repeat(64),
          patch: rawPatch,
          reason: `repair reason ${reasonSentinel}`,
        },
      ]);
      let verificationCall = 0;
      const fake = fakeTools({
        currentBaseHash: "a".repeat(64),
        runVerification: async () => {
          verificationCall += 1;
          return verificationCall === 1
            ? Object.freeze({
                commandId: "test",
                exitCode: 1,
                durationMs: 11,
                timedOut: false,
                status: "completed" as const,
                summary: `initial failed ${initialVerificationSentinel}`,
              })
            : Object.freeze({
                commandId: "test",
                exitCode: 0,
                durationMs: 12,
                timedOut: false,
                status: "completed" as const,
                summary: `final passed ${finalVerificationSentinel}`,
              });
        },
        applyApprovedPatch: async () =>
          Object.freeze({
            path: `src/${toolSentinel}.ts`,
            hash: "b".repeat(64),
          }),
      });
      const repository = createSessionRepository(databasePath);

      try {
        await repository.createSession({
          id: session.id,
          taskKind: session.taskKind,
          state: "created",
          round: 0,
          workspaceId: session.workspaceId,
          providerId: session.providerId,
          verificationCommandId: session.verificationCommandId,
          createdAt: new Date(START_TIME).toISOString(),
        });
        const eventSink: EventSink = repository;
        const controller = createAgentSessionController({
          provider,
          policy: askForPatchPolicy,
          tools: fake.tools,
          eventSink,
          now: sequenceValues(
            Array.from({ length: 12 }, (_, index) => START_TIME + (index + 1) * 1_000),
          ),
          createId: sequenceValues([actionId, approvalId]),
        });

        const pending = await controller.runAgentSession({ session });
        const result = await controller.resolvePendingPatch({
          sessionId: session.id,
          approvalId: pending.pendingPatch?.approvalId ?? "",
          decision: "approve",
        });
        const timeline = await repository.loadTimeline(session.id);

        expect(result.session.state).toBe("completed");
        expect(result.finalSummary).toBe("VERIFICATION_PASSED");
        expect(fake.applyApprovedPatch).toHaveBeenCalledOnce();
        expect(timeline.map((event) => event.kind)).toEqual([
          "verification",
          "state",
          "action",
          "policy",
          "state",
          "approval",
          "approval",
          "tool_result",
          "verification",
          "state",
        ]);
        const approvals = timeline.filter((event) => event.kind === "approval");
        expect(approvals.map((event) => event.details.status)).toEqual([
          "pending",
          "approved",
        ]);
        expect(approvals.map((event) => event.details.actionId)).toEqual([
          actionId,
          actionId,
        ]);
        expect(
          timeline.find((event) => event.kind === "tool_result")?.details,
        ).toEqual({ toolKind: "apply_approved_patch" });
        expect(
          timeline
            .filter((event) => event.kind === "verification")
            .map((event) => event.details),
        ).toEqual([
          {
            commandId: "test",
            exitCode: 1,
            durationMs: 11,
            status: "completed",
            timedOut: false,
          },
          {
            commandId: "test",
            exitCode: 0,
            durationMs: 12,
            status: "completed",
            timedOut: false,
          },
        ]);
        for (const sentinel of sentinels) {
          expect(JSON.stringify(timeline)).not.toContain(sentinel);
        }
        expect(JSON.stringify(timeline)).not.toContain(rawPatch);

        repository.close();

        const database = new Database(databasePath, {
          readonly: true,
          fileMustExist: true,
        });
        try {
          const tables = {
            sessions: database.prepare("SELECT * FROM sessions ORDER BY id").all(),
            timeline: database
              .prepare("SELECT * FROM timeline_events ORDER BY event_id")
              .all(),
            actions: database
              .prepare("SELECT * FROM action_records ORDER BY action_id")
              .all(),
            approvals: database.prepare("SELECT * FROM approvals ORDER BY id").all(),
            verifications: database
              .prepare("SELECT * FROM verification_runs ORDER BY run_id")
              .all(),
            memory: database
              .prepare("SELECT * FROM session_memory ORDER BY session_id")
              .all(),
          };
          expect({
            sessions: tables.sessions.length,
            timeline: tables.timeline.length,
            actions: tables.actions.length,
            approvals: tables.approvals.length,
            verifications: tables.verifications.length,
            memory: tables.memory.length,
          }).toEqual({
            sessions: 1,
            timeline: 10,
            actions: 1,
            approvals: 1,
            verifications: 2,
            memory: 0,
          });
          expect(tables.approvals).toEqual([
            expect.objectContaining({
              id: approvalId,
              action_id: actionId,
              status: "approved",
            }),
          ]);
          expect(tables.verifications).toEqual([
            expect.objectContaining({
              session_id: session.id,
              round: 0,
              command_id: "test",
              exit_code: 1,
              duration_ms: 11,
              status: "completed",
              timed_out: 0,
              summary: "initial failed [REDACTED]",
            }),
            expect.objectContaining({
              session_id: session.id,
              round: 1,
              command_id: "test",
              exit_code: 0,
              duration_ms: 12,
              status: "completed",
              timed_out: 0,
              summary: "final passed [REDACTED]",
            }),
          ]);
          expect(tables.actions).toEqual([
            expect.objectContaining({
              action_id: actionId,
              policy_decision: "ask",
              result_summary: "final passed [REDACTED]",
            }),
          ]);
          const serializedTables = JSON.stringify(tables);
          for (const sentinel of sentinels) {
            expect(serializedTables).not.toContain(sentinel);
          }
          expect(serializedTables).not.toContain(rawPatch);
        } finally {
          database.close();
        }
      } finally {
        repository.close();
      }
    });
  });

  it("fails closed before feature Provider, Policy, or tools when createSession was omitted", async () => {
    await withDatabasePath(async (databasePath) => {
      const repository = createSessionRepository(databasePath);
      try {
        const provider = new ScriptedMockProvider([
          {
            kind: "finish",
            outcome: "needs_human",
            summary: "must not be requested",
          },
        ]);
        const evaluate = vi.fn(askForPatchPolicy.evaluate);
        const fake = fakeTools();
        const controller = createAgentSessionController({
          provider,
          policy: Object.freeze({ evaluate }),
          tools: fake.tools,
          eventSink: repository,
          now: sequenceValues([START_TIME + 1_000]),
          createId: () => "must-not-be-created",
        });
        const session: AgentSession = Object.freeze({
          id: "missing-feature-session",
          taskKind: "feature_implementation",
          state: "created",
          round: 0,
          workspaceId: "workspace-1",
          providerId: "mock-provider-1",
          verificationCommandId: "test",
          taskSummary: "implement the selected feature",
          acceptanceCriteria: "the selected feature passes verification",
        });

        const result = await controller.runAgentSession({ session });

        expect(result.session.state).toBe("failed");
        expect(result.finalSummary).toBe("EVENT_SINK_FAILED");
        expect(result.events).toEqual([]);
        expect(provider.requests).toEqual([]);
        expect(evaluate).not.toHaveBeenCalled();
        expect(fake.listFiles).not.toHaveBeenCalled();
        expect(fake.readFile).not.toHaveBeenCalled();
        expect(fake.searchText).not.toHaveBeenCalled();
        expect(fake.runVerification).not.toHaveBeenCalled();
        expect(fake.getCurrentBaseHash).not.toHaveBeenCalled();
        expect(fake.applyApprovedPatch).not.toHaveBeenCalled();
        await expect(
          repository.loadTimeline(session.id),
        ).resolves.toEqual([]);
      } finally {
        repository.close();
      }
    });
  });

  it("fails closed after only the initial repair verification when createSession was omitted", async () => {
    await withDatabasePath(async (databasePath) => {
      const repository = createSessionRepository(databasePath);
      try {
        const provider = new ScriptedMockProvider([
          {
            kind: "finish",
            outcome: "needs_human",
            summary: "must not be requested",
          },
        ]);
        const evaluate = vi.fn(askForPatchPolicy.evaluate);
        const fake = fakeTools();
        const controller = createAgentSessionController({
          provider,
          policy: Object.freeze({ evaluate }),
          tools: fake.tools,
          eventSink: repository,
          now: sequenceValues([START_TIME + 1_000]),
          createId: () => "must-not-be-created",
        });
        const session: AgentSession = Object.freeze({
          id: "missing-repair-session",
          taskKind: "test_repair",
          state: "created",
          round: 0,
          workspaceId: "workspace-1",
          providerId: "mock-provider-1",
          verificationCommandId: "test",
          taskSummary: "repair the selected failing test",
        });

        const result = await controller.runAgentSession({ session });

        expect(result.session.state).toBe("failed");
        expect(result.finalSummary).toBe("EVENT_SINK_FAILED");
        expect(result.events).toEqual([]);
        expect(provider.requests).toEqual([]);
        expect(evaluate).not.toHaveBeenCalled();
        expect(fake.runVerification).toHaveBeenCalledExactlyOnceWith({
          kind: "run_verification",
          commandId: "test",
        });
        expect(fake.listFiles).not.toHaveBeenCalled();
        expect(fake.readFile).not.toHaveBeenCalled();
        expect(fake.searchText).not.toHaveBeenCalled();
        expect(fake.getCurrentBaseHash).not.toHaveBeenCalled();
        expect(fake.applyApprovedPatch).not.toHaveBeenCalled();
        await expect(
          repository.loadTimeline(session.id),
        ).resolves.toEqual([]);
      } finally {
        repository.close();
      }
    });
  });
});
