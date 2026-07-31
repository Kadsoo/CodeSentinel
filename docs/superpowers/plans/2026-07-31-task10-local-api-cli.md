# Task 10 Local API and CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Deliver a Windows-local Fastify API and CLI that safely compose configured Provider profiles, Credential Manager, the existing Agent Loop and redacted SQLite session history.

**Architecture:** Add @kadsoo/codesentinel-host as the only owner of non-secret profile state, workspace configuration, runtime composition and session scheduling. apps/api maps strict HTTP contracts to Host services; apps/cli maps explicit terminal commands to the same services. Existing Core, Policy, Tools and Persistence remain the enforcement path for every agent action.

**Tech Stack:** TypeScript ESM, Node 22, Fastify 5, Commander 15, Zod 4, better-sqlite3, dynamic keytar, Vitest 4.

---

## File map

| Path | Responsibility |
|---|---|
| packages/contracts/src/config.ts | Strict workspace config schema including profile and path policy bindings. |
| packages/persistence/src/types.ts and session-repository.ts | Bounded ordered session and timeline reads. |
| packages/core/src/types.ts and agent-loop.ts | Cooperative stop probe at external-operation boundaries. |
| packages/host/src/errors.ts | Stable Host-only errors with no native cause. |
| packages/host/src/profile-store.ts | Versioned atomic non-secret profile storage. |
| packages/host/src/workspace-config.ts | Canonical workspace/config loader and privacy-preserving IDs. |
| packages/host/src/runtime.ts | Provider, policy, tool, Core and repository composition. |
| packages/host/src/session-service.ts | One active session, background execution, approvals, stopping and recovery. |
| apps/api/src/server.ts and routes.ts | Loopback Fastify lifecycle and strict local HTTP routes. |
| apps/cli/src/main.ts and credentials.ts | Commander commands, hidden input and credential administration. |

### Task 1: Bind workspace config to profile and path policy

**Files:**
- Modify: packages/contracts/src/config.ts
- Modify: packages/contracts/src/config.test.ts
- Modify: packages/contracts/src/action.test.ts
- Modify: packages/policy/src/command-policy.ts
- Create: packages/policy/src/command-policy.test.ts
- Modify: packages/policy/src/guardrail.test.ts

- [x] **Step 1: Write failing schema tests**

Add a complete configuration fixture and reject missing profile, empty allowlist, parent traversal and unknown keys. Add a command-policy regression proving that a valid verification-command array is accepted without fabricated workspace fields, while an unknown command field remains rejected.

~~~ts
const completeConfig = {
  providerProfileId: "deepseek-default",
  allowedPaths: ["src/**", "tests/**"],
  sensitivePatterns: ["**/.env", "**/*.pem"],
  verificationCommands: [trustedCommand],
};

it("accepts a workspace-bound profile and path policy", () => {
  expect(CodeSentinelConfigSchema.parse(completeConfig)).toMatchObject({
    providerProfileId: "deepseek-default",
    allowedPaths: ["src/**", "tests/**"],
  });
});

it.each([
  { ...completeConfig, providerProfileId: "profile\n" },
  { ...completeConfig, allowedPaths: [] },
  { ...completeConfig, allowedPaths: ["../**"] },
  { ...completeConfig, unexpected: true },
])("rejects unsafe workspace policy config %#", (candidate) => {
  expect(CodeSentinelConfigSchema.safeParse(candidate).success).toBe(false);
});
~~~

- [x] **Step 2: Run RED**

Run: npm test -- --run packages/contracts/src/config.test.ts

Expected: FAIL because the current strict schema only accepts verificationCommands.

- [x] **Step 3: Add strict fields without loosening command validation**

~~~ts
const SafePathPatternSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !hasControlCharacter(value) && !value.includes(".."));

export const CodeSentinelConfigSchema = z
  .object({
    providerProfileId: VerificationIdSchema,
    allowedPaths: z.array(SafePathPatternSchema).min(1).max(64),
    sensitivePatterns: z.array(SafePathPatternSchema).max(64).optional(),
    verificationCommands: VerificationCommandsSchema,
  })
  .strict();
~~~

Keep VerificationCommandSchema unchanged. Update existing policy fixtures to use the complete
configuration. In command-policy, validate only the existing strict verification-command array
schema; do not create profile/path defaults merely to validate a command.

- [x] **Step 4: Run GREEN**

Run: npm test -- --run packages/contracts/src/config.test.ts packages/policy/src/guardrail.test.ts

Expected: PASS.

- [x] **Step 5: Commit**

~~~bash
git add packages/contracts/src/config.ts packages/contracts/src/config.test.ts packages/policy
git commit -m "feat: bind workspace config to profile and path policy"
~~~

### Task 2: Bound persisted session and timeline queries

**Files:**
- Modify: packages/persistence/src/types.ts
- Modify: packages/persistence/src/session-repository.ts
- Modify: packages/persistence/src/session-repository.test.ts

- [x] **Step 1: Write failing repository boundary tests**

Create sessions with different update timestamps and more events than a requested limit. Verify
newest-first session order, chronological selected timeline suffix, and invalid limits.

~~~ts
await repository.createSession(session({ id: "session-old", createdAt: at(1) }));
await repository.createSession(session({ id: "session-new", createdAt: at(2) }));

expect(await repository.listSessions({ limit: 1 })).toMatchObject([
  { id: "session-new" },
]);
await expect(repository.listSessions({ limit: 0 })).rejects.toMatchObject({
  code: "PERSISTENCE_INVALID_INPUT",
});
~~~

- [x] **Step 2: Run RED**

Run: npm test -- --run packages/persistence/src/session-repository.test.ts

Expected: FAIL because listSessions and a bounded timeline signature do not exist.

- [x] **Step 3: Implement typed bounded reads**

~~~ts
export type SessionReadLimit = Readonly<{ limit: number }>;

export interface SessionRepository extends EventSink {
  // existing members
  listSessions(input: SessionReadLimit): Promise<readonly PersistedSession[]>;
  loadTimeline(
    sessionId: string,
    input?: SessionReadLimit,
  ): Promise<readonly HarnessEvent[]>;
}
~~~

Validate a 1 through 500 integer before preparing SQL. Use:
- session list: ORDER BY updated_at DESC, id DESC LIMIT ?;
- timeline: reverse an inner ORDER BY event_index DESC LIMIT ? selection.

Preserve existing schema fingerprint validation, strict row decoding and redaction.

- [x] **Step 4: Run GREEN**

Run: npm test -- --run packages/persistence/src/session-repository.test.ts packages/persistence/src/core-integration.test.ts

Expected: PASS including DB, journal, WAL and SHM leak regressions.

- [x] **Step 5: Commit**

~~~bash
git add packages/persistence/src/types.ts packages/persistence/src/session-repository.ts packages/persistence/src/session-repository.test.ts
git commit -m "feat: bound persisted session and timeline reads"
~~~

### Task 3: Stop Core at safe operation boundaries

**Files:**
- Modify: packages/core/src/types.ts
- Modify: packages/core/src/agent-loop.ts
- Modify: packages/core/src/agent-loop.test.ts

- [ ] **Step 1: Write failing stop tests**

Use a deferred Provider or verification fake. Set a stop flag after the external operation begins and
verify that no next Provider action or patch write occurs.

~~~ts
let stopRequested = false;
const controller = createAgentSessionController({
  ...createDependencies({ provider: deferredProvider }),
  shouldStop: (sessionId) => sessionId === "repair-session-1" && stopRequested,
});

const resultPromise = controller.runAgentSession({ session: createdRepairSession() });
stopRequested = true;
releaseDeferredProvider();

await expect(resultPromise).resolves.toMatchObject({
  session: { state: "stopped" },
  finalSummary: "STOP_REQUESTED",
});
expect(tools.applyApprovedPatch).not.toHaveBeenCalled();
~~~

Also prove that no probe preserves all existing behavior and a throwing probe stops without exposing
the thrown value.

- [ ] **Step 2: Run RED**

Run: npm test -- --run packages/core/src/agent-loop.test.ts

Expected: FAIL because AgentLoopDependencies has no shouldStop member.

- [ ] **Step 3: Add the optional immutable StopProbe**

~~~ts
export type StopProbe = (sessionId: string) => boolean;

export type AgentLoopDependencies = Readonly<{
  provider: Provider;
  policy: BoundPolicy;
  tools: ToolDispatcher;
  eventSink: EventSink;
  now: () => number;
  createId: () => string;
  shouldStop?: StopProbe;
}>;
~~~

Implement private stopIfRequested(record). Call it before and after each awaited Provider, tool or
approval operation, but never recursively while appending its terminal state event. Route true or thrown probes to terminal(record, "stopped",
"STOP_REQUESTED"). Once terminal, no later action is appended. Do not modify round limits, event
shape, policy decisions or approval hashes.

- [ ] **Step 4: Run GREEN**

Run: npm test -- --run packages/core/src/agent-loop.test.ts packages/core/src/approval-resume.test.ts packages/persistence/src/core-integration.test.ts

Expected: PASS.

- [ ] **Step 5: Commit**

~~~bash
git add packages/core/src/types.ts packages/core/src/agent-loop.ts packages/core/src/agent-loop.test.ts
git commit -m "feat: stop agent sessions at safe boundaries"
~~~

### Task 4: Store atomic non-secret Provider profiles

**Files:**
- Create: packages/host/package.json
- Create: packages/host/src/errors.ts
- Create: packages/host/src/profile-store.ts
- Create: packages/host/src/profile-store.test.ts
- Create: packages/host/src/index.ts

- [ ] **Step 1: Write failing profile tests**

Use a temporary injected state directory. Cover profile round trip, a malformed/oversize/unknown-key
file, duplicate IDs, endpoint query/fragment, non-safe refs and a secret-sentinel scan.

~~~ts
const store = createProfileStore({ stateDirectory, randomSuffix: () => "test" });
await store.upsert({
  id: "deepseek-default",
  kind: "deepseek",
  endpoint: "https://api.deepseek.com/chat/completions",
  model: "deepseek-v4-flash",
  credentialRef: "deepseek-default",
});

expect(await store.get("deepseek-default")).toMatchObject({ kind: "deepseek" });
expect(await readFile(join(stateDirectory, "profiles.json"), "utf8")).not.toContain(secretSentinel);
await expect(
  store.upsert({ ...validProfile, endpoint: "https://host/path?token=x" }),
).rejects.toMatchObject({ code: "PROFILE_INVALID" });
~~~

- [ ] **Step 2: Run RED**

Run: npm test -- --run packages/host/src/profile-store.test.ts

Expected: FAIL because the Host package and profile store are absent.

- [ ] **Step 3: Implement strict profile envelopes and atomic replacement**

~~~ts
export type ProviderProfile = Readonly<{
  id: string;
  kind: "deepseek" | "nju_se_hub";
  endpoint: string;
  model: string;
  credentialRef: string;
}>;

export interface ProfileStore {
  get(id: string): Promise<ProviderProfile | undefined>;
  list(): Promise<readonly ProviderProfile[]>;
  upsert(profile: ProviderProfile): Promise<void>;
  remove(id: string): Promise<void>;
}
~~~

Use a strict Zod envelope with version 1 and profiles, rejecting duplicate IDs before any write. Write a same-directory temporary file with
flag wx, close it, then rename it over profiles.json. Reject a symlink/non-regular profile file and
never overwrite a corrupted existing profile. Export HostError codes PROFILE_INVALID,
PROFILE_NOT_FOUND, STATE_UNAVAILABLE and STATE_CORRUPT. The error has no cause or input field.

- [ ] **Step 4: Run GREEN**

Run: npm test -- --run packages/host/src/profile-store.test.ts && npm run typecheck && npm run lint

Expected: PASS.

- [ ] **Step 5: Commit**

~~~bash
git add packages/host package-lock.json
git commit -m "feat: add atomic local provider profiles"
~~~

### Task 5: Load canonical workspaces and compose runtimes

**Files:**
- Create: packages/host/src/workspace-config.ts
- Create: packages/host/src/workspace-config.test.ts
- Create: packages/host/src/runtime.ts
- Create: packages/host/src/runtime.test.ts
- Modify: packages/host/src/index.ts

- [ ] **Step 1: Write failing loader and composition tests**

Use isolated fixture directories. Validate a canonical real directory and config, and verify the
derived workspace ID does not contain the raw workspace path. Reject absent config, symlink root,
invalid JSON, unknown verification command and missing credential. Inject fake Provider factory,
Credential Store, Repository and clock.

~~~ts
await expect(loader.load({ workspacePath: missingDirectory })).rejects.toMatchObject({
  code: "WORKSPACE_INVALID",
});

const loaded = await loader.load({ workspacePath: fixtureRoot });
expect(loaded.workspaceId).not.toContain(fixtureRoot);
expect(loaded.config.verificationCommands.map((command) => command.id)).toEqual(["test"]);
~~~

- [ ] **Step 2: Run RED**

Run: npm test -- --run packages/host/src/workspace-config.test.ts packages/host/src/runtime.test.ts

Expected: FAIL because the loader and runtime composition are absent.

- [ ] **Step 3: Implement canonical loading and runtime composition**

Load only canonicalRoot/codesentinel.json with a 64 KiB cap. Reject non-directories and root
symlinks. Parse CodeSentinelConfigSchema and derive workspace- plus lower-case SHA-256(canonical path).

Runtime creation must:
1. resolve only the config-selected profile;
2. require CredentialStore.status(ref) to be configured before get(ref);
3. compose OpenAICompatibleProvider, createPolicy, createToolDispatcher and
   createAgentSessionController using one canonical root/config;
4. pass the SessionRepository event sink and Host StopProbe;
5. never return, persist or log a secret.

Keep ProviderFactory injectable so tests use no transport.

- [ ] **Step 4: Run GREEN**

Run: npm test -- --run packages/host/src/workspace-config.test.ts packages/host/src/runtime.test.ts packages/providers/src/credential-store.test.ts packages/policy/src/guardrail.test.ts packages/core/src/tool-dispatcher.test.ts

Expected: PASS.

- [ ] **Step 5: Commit**

~~~bash
git add packages/host
git commit -m "feat: compose canonical workspace agent runtimes"
~~~

### Task 6: Schedule, recover and stop one local session

**Files:**
- Create: packages/host/src/session-service.ts
- Create: packages/host/src/session-service.test.ts
- Modify: packages/host/src/errors.ts
- Modify: packages/host/src/index.ts

- [ ] **Step 1: Write failing service tests**

Inject a controlled runtime/controller and repository. Verify persistence happens before background
execution, second nonterminal creation receives SESSION_ACTIVE, approvals reach only the matching
runtime, reads pass limits, recovery happens before creation and stops are idempotent.

~~~ts
const accepted = await service.create({ ...validRequest, taskKind: "test_repair" });
expect(accepted).toMatchObject({ state: "created" });
expect(repository.createSession.mock.invocationCallOrder[0]).toBeLessThan(
  controller.runAgentSession.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
);

await expect(service.create(validRequest)).rejects.toMatchObject({ code: "SESSION_ACTIVE" });
await service.stop({ sessionId: accepted.sessionId });
expect(stopProbe(accepted.sessionId)).toBe(true);
~~~

- [ ] **Step 2: Run RED**

Run: npm test -- --run packages/host/src/session-service.test.ts

Expected: FAIL because no Host session service exists.

- [ ] **Step 3: Implement asynchronous single-session coordination**

~~~ts
export interface SessionService {
  create(input: CreateLocalSessionInput): Promise<CreatedLocalSession>;
  get(sessionId: string): Promise<PersistedSession | undefined>;
  list(limit: number): Promise<readonly PersistedSession[]>;
  timeline(sessionId: string, limit: number): Promise<readonly HarnessEvent[]>;
  resolveApproval(input: ResolvePendingPatchInput): Promise<void>;
  stop(input: Readonly<{ sessionId: string }>): Promise<"accepted" | "already_stopped">;
  recover(): Promise<number>;
}
~~~

Serialize mutation of the active runtime. Persist created before launching void run(). Retain the
runtime through awaiting_approval; clear it only after terminal Core result. For awaiting approval,
append one valid state/stopped event and remove the runtime immediately. For running, set only the
StopProbe flag; Core stops at its next safe boundary. Repeated stops must not create duplicate events.

- [ ] **Step 4: Run GREEN**

Run: npm test -- --run packages/host/src/session-service.test.ts packages/core/src/agent-loop.test.ts packages/persistence/src/session-lifecycle.test.ts

Expected: PASS.

- [ ] **Step 5: Commit**

~~~bash
git add packages/host/src/session-service.ts packages/host/src/session-service.test.ts packages/host/src/errors.ts packages/host/src/index.ts
git commit -m "feat: coordinate local agent sessions"
~~~

### Task 7: Expose strict loopback API routes

**Files:**
- Create: apps/api/package.json
- Create: apps/api/src/server.ts
- Create: apps/api/src/routes.ts
- Create: apps/api/src/routes.test.ts
- Create: apps/api/src/server.test.ts

- [ ] **Step 1: Write failing Fastify inject tests**

Cover strict body parsing, 202 creation, 409 active session, 400 unknown command, bounded list/timeline
query values, approval, stop idempotence, credential status and no secret echo.

~~~ts
const response = await app.inject({
  method: "POST",
  url: "/sessions",
  payload: {
    taskKind: "test_repair",
    workspacePath: "C:/repo",
    verificationCommandId: "unknown",
    taskSummary: "repair",
  },
});

expect(response.statusCode).toBe(400);
expect(response.json()).toEqual({ code: "CONFIG_INVALID" });

const created = await app.inject({
  method: "POST",
  url: "/sessions",
  payload: validSessionBody,
});
expect(created.statusCode).toBe(202);
expect(created.json()).toEqual({ sessionId: "session-1", state: "created" });
~~~

Test a fake listener receives exactly host 127.0.0.1 and port 48761 and maps EADDRINUSE to
SERVER_ALREADY_RUNNING without process probing or termination.

- [ ] **Step 2: Run RED**

Run: npm test -- --run apps/api/src/routes.test.ts apps/api/src/server.test.ts

Expected: FAIL because the API package is absent.

- [ ] **Step 3: Implement Fastify as a thin Host adapter**

Build Fastify with logger false and bodyLimit 16 * 1024. Strict Zod schemas allow session list limits
1 through 100 and timeline limits 1 through 500. Map known Host errors to 400, 404, 409 or 503 and
return only a code. Map unexpected errors to INTERNAL_ERROR without messages.

Register only health, workspace validation, sessions, session detail/timeline, approval, stop and
credential status/set/clear routes. PUT credential accepts only an existing profile and a secret;
it returns 204 and never logs/echoes it. Do not add CORS, remote hosts, static public assets or a
credential read route. Export buildServer for inject tests and startServer for the fixed port.

- [ ] **Step 4: Run GREEN**

Run: npm test -- --run apps/api/src/routes.test.ts apps/api/src/server.test.ts && npm run typecheck

Expected: PASS.

- [ ] **Step 5: Commit**

~~~bash
git add apps/api package-lock.json
git commit -m "feat: expose loopback session API"
~~~

### Task 8: Add safe credential and server CLI commands

**Files:**
- Create: apps/cli/package.json
- Create: apps/cli/src/credentials.ts
- Create: apps/cli/src/credentials.test.ts
- Create: apps/cli/src/main.ts
- Create: apps/cli/src/main.test.ts

- [ ] **Step 1: Write failing CLI tests**

Inject terminal streams, a hidden prompt port and Host services. Assert set requires TTY, prompts
once without printing the secret sentinel, status prints only configured/missing, clear calls
Credential Store before profile removal and start never probes a Provider.

~~~ts
const output = createCapturedOutput();
await runCli([
  "credentials",
  "set",
  "deepseek-default",
  "--provider",
  "deepseek",
  "--model",
  "deepseek-v4-flash",
], dependencies);

expect(output.text()).not.toContain(secretSentinel);
expect(await profileStore.get("deepseek-default")).toMatchObject({
  endpoint: "https://api.deepseek.com/chat/completions",
});
~~~

- [ ] **Step 2: Run RED**

Run: npm test -- --run apps/cli/src/credentials.test.ts apps/cli/src/main.test.ts

Expected: FAIL because the CLI package is absent.

- [ ] **Step 3: Implement testable Commander commands**

Export runCli(argv, dependencies): Promise<number>; main calls it with production streams. Set accepts a
safe ID, provider enum, model maximum 128 and optional endpoint. Use the official DeepSeek endpoint
only for deepseek; require an HTTPS endpoint for nju-se-hub. Non-TTY input fails with
CREDENTIAL_UNAVAILABLE and never reads an environment variable or prints a secret.

Status prints exactly profileId: configured or profileId: missing. Set validates and persists the
non-secret profile first, then writes the secret; if the credential write fails, the safe profile
remains with missing status so the user can retry. Clear calls Credential Store first, then removes
the profile. Probe is explicit and calls the injected probe once. Load keytar only inside
an explicit credential/session production operation, never at module import, startup, CI or test time.

- [ ] **Step 4: Run GREEN**

Run: npm test -- --run apps/cli/src/credentials.test.ts apps/cli/src/main.test.ts packages/providers/src/credential-store.test.ts packages/providers/src/openai-compatible.test.ts

Expected: PASS.

- [ ] **Step 5: Commit**

~~~bash
git add apps/cli package-lock.json
git commit -m "feat: add local credential and server CLI"
~~~

### Task 9: Integrate, independently review and record evidence

**Files:**
- Modify: PLAN.md
- Modify: AGENT_LOG.md
- Review: all changes since docs-task10-api-cli-design

- [ ] **Step 1: Write cross-component RED regression tests**

Use profile, controlled workspace, fake provider and test repository fixtures. Start through HTTP,
observe a redacted SQLite timeline, reject concurrent creation, issue stop, and scan profiles.json,
SQLite, journal, WAL, SHM, HTTP response and captured CLI output for a secret sentinel.

- [ ] **Step 2: Run RED**

Run: npm test -- --run packages/host/src/session-service.test.ts apps/api/src/routes.test.ts apps/cli/src/main.test.ts

Expected: at least the new integration assertion fails before its minimal fix.

- [ ] **Step 3: Implement only the demonstrated fix and run focused GREEN**

Do not introduce a real Provider call, user workspace path, unbounded read, direct patch write,
plaintext credential fallback or network test.

Run: npm test -- --run packages/host/src apps/api/src apps/cli/src packages/core/src/agent-loop.test.ts packages/persistence/src

Expected: PASS.

- [ ] **Step 4: Review final diff against requirements**

Inspect SPEC.md sections 4.1 through 4.3, 5, 7 through 9 and the Task 10 design. Check strict inputs,
atomic profiles, credential non-leakage, endpoint validation, one active session, stopping, bounded
reads, recovery, loopback binding and test process cleanup. Every Critical or Important finding needs
a new RED test before its minimal fix.

- [ ] **Step 5: Run final verification**

~~~powershell
npm test
npm run typecheck
npm run lint
npm run build
git diff --check docs-task10-api-cli-design...HEAD
git status --short --branch
~~~

Expected: all tests pass apart from explicitly documented skips; all commands exit 0; no test-started
server remains; the worktree is clean before evidence edits.

- [ ] **Step 6: Record factual completion evidence**

Update the Task 10 PLAN block and append a dated AGENT_LOG entry using actual commit IDs, RED/GREEN
counts, final verification output, review outcomes, process cleanup and remote state.

~~~bash
git add PLAN.md AGENT_LOG.md
git commit -m "docs: record task 10 API and CLI evidence"
~~~

## Plan self-review

- Coverage: Task 1 binds profile/path configuration; Task 2 bounds persistence; Task 3 stops Core;
  Tasks 4 through 6 create state, composition and lifecycle; Tasks 7 and 8 expose API/CLI; Task 9
  performs integration, review and factual evidence.
- No deferred design selection remains. Every change task names exact files, test commands and
  expected results.
- Type order is consistent: ProviderProfile/ProfileStore, StopProbe, SessionReadLimit and
  SessionService are defined before their consumers.
- No task allows a real credential/network test, HTTP fallback for NJU, direct patch writing or
  server port override.
