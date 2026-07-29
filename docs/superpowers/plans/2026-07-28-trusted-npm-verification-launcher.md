# Trusted npm Verification Launcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace bare package-manager verification commands with a configured, bounded `node_npm_cli` launcher that runs npm through Node without an outer shell.

**Architecture:** Contracts own the strict launcher grammar and the shared resource ceilings; Task 3 policy accepts only a parsed configured command with that grammar. The tools package resolves the npm JavaScript CLI adjacent to the running Node executable, starts it through `process.execPath` with `shell: false`, and returns only bounded, redacted, stable results. Task 8 remains responsible for Policy authorization, immutable configuration lookup, and workspace containment.

**Tech Stack:** TypeScript 5.9, Zod 4, Node 22 child_process/fs/promises, Vitest 4.

---

## File map

| File | Responsibility |
| --- | --- |
| `packages/contracts/src/config.ts` | Strict verification launcher schema, command argument grammar, shared hard limits. |
| `packages/contracts/src/config.test.ts` | Contract acceptance/rejection and upper-bound tests. |
| `packages/contracts/src/index.ts` | Publicly export the launcher constants and types. |
| `packages/policy/src/command-policy.ts` | Accept only parsed `node_npm_cli` configurations. |
| `packages/policy/src/guardrail.test.ts` | Policy tests for new launcher shape and legacy rejection. |
| `packages/tools/src/verification.ts` | Trusted npm CLI resolution, no-shell spawn, bounded capture, redaction, timeout and stable results. |
| `packages/tools/src/verification.test.ts` | Real npm fixture runner tests for success, timeout, output limits, redaction, input and environment failures. |
| `packages/tools/src/index.ts` | Export the runner API and result types. |
| `PLAN.md` / `AGENT_LOG.md` | Completion evidence after the implementation is reviewed and merged. |

### Task 1: Replace bare executable configuration with the trusted launcher contract

**Files:**

- Modify: `packages/contracts/src/config.ts`
- Modify: `packages/contracts/src/config.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/policy/src/command-policy.ts`
- Modify: `packages/policy/src/guardrail.test.ts`

- [ ] **Step 1: Write failing contract and policy tests**

Add these exact expectations to `packages/contracts/src/config.test.ts` and `packages/policy/src/guardrail.test.ts` before changing production code:

```ts
const trustedCommand = {
  id: "test",
  launcher: "node_npm_cli",
  args: ["test"],
  timeoutMs: 1_000,
  maxOutputBytes: 1_024,
};

it("accepts an explicit trusted npm CLI launcher", () => {
  expect(CodeSentinelConfigSchema.parse({ verificationCommands: [trustedCommand] }))
    .toMatchObject({ verificationCommands: [{ launcher: "node_npm_cli", args: ["test"] }] });
});

it("rejects legacy executable and Windows command-wrapper configuration", () => {
  for (const executable of ["npm", "npm.cmd", "npm.bat", "cmd.exe"]) {
    expect(CodeSentinelConfigSchema.safeParse({
      verificationCommands: [{ ...trustedCommand, executable, launcher: undefined }],
    }).success).toBe(false);
  }
});

it("rejects arguments and budgets outside the trusted runner grammar", () => {
  for (const candidate of [
    { ...trustedCommand, args: ["test", "&&", "publish"] },
    { ...trustedCommand, args: ["run", "deploy"] },
    { ...trustedCommand, timeoutMs: MAX_VERIFICATION_TIMEOUT_MS + 1 },
    { ...trustedCommand, maxOutputBytes: MAX_VERIFICATION_OUTPUT_BYTES + 1 },
  ]) {
    expect(CodeSentinelConfigSchema.safeParse({ verificationCommands: [candidate] }).success)
      .toBe(false);
  }
});
```

Add a guardrail case that allows `{ kind: "run_verification", commandId: "test" }` only with `trustedCommand`, and denies the legacy `executable: "npm.cmd"` shape even if its `id` matches.

- [ ] **Step 2: Run the focused tests and record red**

Run:

```powershell
npm test -- --run packages/contracts/src/config.test.ts packages/policy/src/guardrail.test.ts
```

Expected: failure because `launcher`, `MAX_VERIFICATION_TIMEOUT_MS`, and `MAX_VERIFICATION_OUTPUT_BYTES` are not implemented and the existing schema still requires `executable`.

- [ ] **Step 3: Implement the strict shared contract and policy grammar**

In `packages/contracts/src/config.ts`, replace the executable field with a literal launcher and bounded argument union. Keep the schema strict and export the limits from the same module so runtime and configuration use identical ceilings:

```ts
export const MAX_VERIFICATION_TIMEOUT_MS = 60_000;
export const MAX_VERIFICATION_OUTPUT_BYTES = 65_536;

const VerificationIdSchema = IdentifierSchema
  .max(128)
  .refine((value) => !/[\0\u0001-\u001f\u007f]/u.test(value));
const NpmScriptSchema = z.enum(["check", "lint", "test", "typecheck", "verify"]);
const NpmArgumentsSchema = z.union([
  z.tuple([z.literal("test")]),
  z.tuple([z.union([z.literal("run"), z.literal("run-script")]), NpmScriptSchema]),
]);

export const VerificationCommandSchema = z.object({
  id: VerificationIdSchema,
  launcher: z.literal("node_npm_cli"),
  args: NpmArgumentsSchema,
  timeoutMs: z.number().int().safe().positive().max(MAX_VERIFICATION_TIMEOUT_MS),
  maxOutputBytes: z.number().int().safe().positive().max(MAX_VERIFICATION_OUTPUT_BYTES),
}).strict();
```

Export `MAX_VERIFICATION_TIMEOUT_MS`, `MAX_VERIFICATION_OUTPUT_BYTES`, and `VerificationCommand` from `packages/contracts/src/index.ts`. Simplify `isConfiguredVerificationCommand` so it parses the full strict configuration and matches only the normalized `id`; it must not inspect executable names or accept a fallback shape.

- [ ] **Step 4: Run focused tests and static checks**

Run:

```powershell
npm test -- --run packages/contracts/src/config.test.ts packages/policy/src/guardrail.test.ts
npm run typecheck
npm run lint
```

Expected: all commands pass; no policy test accepts `.cmd`, `.bat`, `cmd.exe`, arbitrary script names, oversized timeout, or oversized output budget.

- [ ] **Step 5: Commit the contract boundary**

```powershell
git add packages/contracts/src/config.ts packages/contracts/src/config.test.ts packages/contracts/src/index.ts packages/policy/src/command-policy.ts packages/policy/src/guardrail.test.ts
git commit -m "feat: configure trusted npm verification launcher"
```

### Task 2: Implement bounded trusted npm CLI execution

**Files:**

- Create: `packages/tools/src/verification.ts`
- Create: `packages/tools/src/verification.test.ts`
- Modify: `packages/tools/src/index.ts`

- [ ] **Step 1: Write failing runner tests against disposable trusted npm fixtures**

Create a fixture helper in `packages/tools/src/verification.test.ts` that writes a temporary `package.json` with one named script, invokes `runVerification`, and removes the fixture in `finally`. Do not use network, global npm configuration, or a raw shell command.

```ts
const npmTestCommand = {
  id: "test",
  launcher: "node_npm_cli" as const,
  args: ["test"] as const,
  timeoutMs: 1_000,
  maxOutputBytes: 1_024,
};

it("runs a configured npm test through Node without an outer shell", async () => {
  await withPackageFixture('node -e "process.stdout.write(\"ok\")"', async (cwd) => {
    await expect(runVerification({ command: npmTestCommand, cwd })).resolves.toMatchObject({
      commandId: "test",
      status: "completed",
      exitCode: 0,
      timedOut: false,
    });
  });
});

it("returns a stable timeout result and no raw child-process error", async () => {
  await withPackageFixture('node -e "setTimeout(() => {}, 5000)"', async (cwd) => {
    const result = await runVerification({
      command: { ...npmTestCommand, timeoutMs: 20 },
      cwd,
    });
    expect(result).toMatchObject({ status: "timed_out", timedOut: true, exitCode: null });
    expect(result.summary).not.toMatch(/ENOENT|spawn|\\\\|\/[A-Za-z]:/u);
  });
});

it("kills an output flood and returns no truncated raw body", async () => {
  await withPackageFixture('node -e "process.stdout.write(\"x\".repeat(8192))"', async (cwd) => {
    await expect(runVerification({
      command: { ...npmTestCommand, maxOutputBytes: 16 },
      cwd,
    })).resolves.toEqual(expect.objectContaining({
      status: "output_limit",
      exitCode: null,
      summary: "VERIFICATION_OUTPUT_LIMIT",
    }));
  });
});
```

Add separate expectations for a non-zero npm script exit, missing/non-directory `cwd`, an invalid legacy command object, no inherited `NODE_OPTIONS`/test secret, redaction of `Bearer secret-value`, control-byte removal, and stable `spawn_failed` output when the trusted launcher cannot be resolved through a mocked resolver. Add a Windows-only case asserting `.cmd`/`.bat` objects fail schema validation and do not lead to `spawn`.

- [ ] **Step 2: Run the runner test and record red**

Run:

```powershell
npm test -- --run packages/tools/src/verification.test.ts
```

Expected: failure because `verification.js` and `runVerification` do not exist.

- [ ] **Step 3: Implement the minimal no-shell runner**

Define and export these public types from `packages/tools/src/verification.ts`:

```ts
export type VerificationStatus = "completed" | "timed_out" | "spawn_failed" | "output_limit";
export type VerificationResult = Readonly<{
  commandId: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  status: VerificationStatus;
  summary: string;
}>;
export type RunVerificationInput = Readonly<{
  command: VerificationCommand;
  cwd: string;
}>;
```

Implement these private responsibilities in the same focused file:

1. `validateInput` uses `VerificationCommandSchema.safeParse`, requires `cwd` to be absolute, canonicalizes it with `realpath`, and requires a directory. Invalid input returns `spawn_failed` with `VERIFICATION_INPUT_INVALID`; no Zod or filesystem message escapes.
2. `resolveTrustedNpmInvocation` canonicalizes `process.execPath`, resolves `<nodeDir>/node_modules/npm/bin/npm-cli.js`, requires a contained regular file, and returns `[nodeExecutable, [npmCliPath, ...command.args], nodeDir]`. Any failure returns `spawn_failed` with `VERIFICATION_LAUNCHER_UNAVAILABLE`; it never reads PATH or a `.cmd` wrapper.
3. `buildChildEnvironment` returns only a fixed PATH rooted at `nodeDir`, plus `SystemRoot`, `ComSpec`, `TEMP`, and `TMP` when present on Windows. It omits parent API-key-like variables, `NODE_OPTIONS`, all `npm_config_*`, proxies, and user PATH entries.
4. `captureBoundedOutput` stores at most the command's shared byte budget across stdout and stderr. On the first overflow it stops copying, requests direct-child termination, and selects `output_limit`; it returns no captured raw output for that status.
5. `settleOnce` owns `error`, `close`, timeout, and output-limit races. It resolves only after `close` for ordinary/terminated children, exposes `exitCode: null` for timeout/limit/spawn failure, and never throws raw process errors.
6. `summarizeCompletedOutput` decodes only bounded bytes, converts invalid UTF-8 to `VERIFICATION_NON_TEXT_OUTPUT`, strips NUL/C0/ANSI controls, applies bearer/`sk-`/password-token-api-key redaction, and caps the returned summary to 4,096 characters.

Spawn only with this literal options object:

```ts
{
  cwd: canonicalCwd,
  env: buildChildEnvironment(nodeDirectory),
  shell: false,
  windowsHide: true,
  windowsVerbatimArguments: false,
  detached: false,
  stdio: ["ignore", "pipe", "pipe"],
}
```

Do not add `cmd.exe`, `exec`, `execFile`, an arbitrary executable API, `AbortSignal`, PATH fallback, or a general process-tree killer.

- [ ] **Step 4: Export and verify runner behavior**

Export `runVerification` and its types from `packages/tools/src/index.ts`. Run:

```powershell
npm test -- --run packages/tools/src/verification.test.ts
npm test
npm run typecheck
npm run lint
git diff --check
```

Expected: focused and full tests pass; output-flood and timeout fixtures leave no active direct child process; public results contain only stable status/summary values and never raw OS errors.

- [ ] **Step 5: Commit the runner**

```powershell
git add packages/tools/src/verification.ts packages/tools/src/verification.test.ts packages/tools/src/index.ts
git commit -m "feat: run trusted npm verification safely"
```

### Task 3: Review the security boundary and record completion

**Files:**

- Modify: `PLAN.md`
- Modify: `AGENT_LOG.md`

- [ ] **Step 1: Run an independent specification/security review**

Review the final range against `docs/superpowers/specs/2026-07-28-task6-trusted-npm-launcher-design.md`. The review must verify no outer shell or `.cmd` fallback exists, contracts and policy no longer accept legacy executable configuration, output limits are shared and hard-bounded, errors are stable/redacted, and no claim of workspace sandboxing or process-tree termination is made.

- [ ] **Step 2: Run an independent code-quality review**

Review the final range only after specification review is COMPLIANT. Check TypeScript narrowing, listener/timer cleanup, test fixture cleanup, Windows behavior, public exports, and readability. Critical or Important findings return to the same implementation agent for TDD fixes and re-review.

- [ ] **Step 3: Record actual evidence after merge**

After local merge and a fresh main-branch verification, mark Task 6's original `PLAN.md` steps complete and append only real commit hashes, test counts, review verdicts, platform skips, and retained boundaries to `AGENT_LOG.md`.
