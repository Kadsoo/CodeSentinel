# Task 6 Trusted No-Shell npm Launcher Design

**Status:** User-approved design scope on 2026-07-28; implementation requires a separate reviewed plan.

## Goal

Provide a bounded, no-outer-shell verification runner that can execute configured npm verification commands on Windows without invoking `npm.cmd`, `npm.bat`, `cmd.exe /c`, or `shell: true` from CodeSentinel.

## Problem and decision

The existing policy permits bare package-manager names and Windows `.cmd`/`.bat` variants. Node cannot directly execute those script wrappers with `spawn({ shell: false })`. Enabling a shell merely to make them work would undo Task 6's principal security property.

The runner will instead support one explicit launcher: `node_npm_cli`. It starts the npm JavaScript CLI through the Node executable already running CodeSentinel:

```text
process.execPath [trusted npm-cli.js, ...configured npm arguments]
```

The runner never resolves or launches a bare `npm`, `npm.cmd`, or `npm.bat` executable, and it never falls back to `cmd.exe`, `exec`, `execFile`, or `shell: true`.

## Contract and policy migration

`VerificationCommand` changes from an arbitrary executable/argument pair to this strict, forward-compatible shape:

```ts
type VerificationCommand = Readonly<{
  id: string;
  launcher: "node_npm_cli";
  args: readonly ["test"] | readonly ["run" | "run-script", "check" | "lint" | "test" | "typecheck" | "verify"];
  timeoutMs: number;
  maxOutputBytes: number;
}>;
```

The schema rejects legacy `executable`, any `.cmd`/`.bat` spelling, unknown launcher kinds, unknown fields, NUL/control-bearing values, more arguments, and values above the runner's hard limits. Task 3's command policy recognizes only this launcher and the same restricted npm argument grammar. A policy allow is still not an execution authorization by itself.

The eventual Task 8 dispatcher must:

1. parse and freeze the configuration snapshot;
2. use Task 3 policy to allow the requested `commandId`;
3. resolve that exact command from the same snapshot;
4. canonicalize and authorize the workspace `cwd`; and only then
5. call Task 6.

Task 6 performs defensive runtime validation but neither accepts LLM/API-supplied executable data as authorized nor proves human approval.

## Trusted launcher resolution

At each run, the runner resolves `process.execPath` and the adjacent bundled npm CLI at:

```text
<real directory of process.execPath>/node_modules/npm/bin/npm-cli.js
```

Both paths are canonicalized. The CLI must be a regular file contained under the canonical Node installation directory. Failure yields a stable `spawn_failed` result with a fixed summary; there is no PATH search or fallback wrapper.

This assumes the local Node installation is trusted. It does not claim to authenticate Node/npm binaries against a hostile local administrator or an executable-replacement race.

## Runner behavior

`runVerification({ command, cwd })` retains the planned public shape. It requires an existing, canonical absolute directory and never defaults to `process.cwd()`. Since this API has no workspace root, it cannot prove `cwd` belongs to the selected workspace; that is an explicit Task 8 precondition.

The only spawn options are:

```ts
{
  shell: false,
  windowsHide: true,
  windowsVerbatimArguments: false,
  detached: false,
  stdio: ["ignore", "pipe", "pipe"],
}
```

The process receives a fixed environment whitelist: CodeSentinel's Node directory on `PATH`, platform runtime variables needed to run Node/npm (`SystemRoot`, `ComSpec`, `TEMP`, and `TMP` on Windows), and no inherited API keys, bearer tokens, `NODE_OPTIONS`, `npm_config_*`, proxy settings, or user-controlled `PATH` entries. This is process hygiene, not a sandbox: a trusted workspace's npm scripts can themselves run arbitrary local code.

Module hard limits are `60_000` milliseconds and `65_536` combined stdout/stderr bytes. Parsed configuration must be positive and no greater than those limits. The runner never allocates from an unbounded config value.

On timeout or output-limit breach it sends termination to the direct child, waits for `close` when possible, and returns a stable status. It does not claim to kill grandchildren or detached processes; Windows Job Objects or OS isolation would be needed for that guarantee.

## Result and output handling

```ts
type VerificationResult = Readonly<{
  commandId: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  status: "completed" | "timed_out" | "spawn_failed" | "output_limit";
  summary: string;
}>;
```

Normal non-zero exits are `completed` results, not raw exceptions. Spawn failures, termination failures, timeout races, and OS errors never expose paths, errno values, environment variables, stack traces, or child-process messages.

stdout and stderr share one byte budget and are buffered only up to that limit. Once the limit is crossed, the runner returns a fixed `output_limit` summary rather than a partially captured body, preventing a secret split across the truncation boundary from leaking. For completed output, the runner decodes bounded bytes as UTF-8, removes NUL/C0/ANSI control sequences, redacts common bearer tokens, `sk-...` tokens, and password/token/API-key key-value forms, and caps the final summary. It never writes raw output to the console.

## Test plan

Tests use the real `node_npm_cli` launcher against disposable trusted package fixtures. TDD must first record missing-module/red behavior, then add focused regressions for:

- valid `npm test` success and non-zero exit;
- timeout and output flood termination, with child PID cleanup in test `finally` blocks;
- shared output cap, a single overlarge chunk, and fixed no-output limit summaries;
- invalid schema/runtime command data, non-directory `cwd`, missing launcher, and stable spawn failure results without raw OS details;
- no inherited `NODE_OPTIONS` or test secret environment variable;
- stdout/stderr redaction, UTF-8 split chunks, invalid bytes, NUL/control sequences, and secret-at-limit behavior;
- Windows-only proof that `.cmd`/`.bat` configurations are rejected rather than routed through a shell;
- policy acceptance of only `node_npm_cli` and rejection of the legacy executable shape.

The full suite, typecheck, lint, lockfile consistency, and two independent reviews remain mandatory before merge.

## Explicit non-goals and retained boundaries

- No general-purpose command launcher, arbitrary Node `-e` capability, shell support, PATH-based package-manager resolution, or compatibility fallback.
- No authorization, approval, session ownership, workspace containment, configuration persistence, or API input ownership; those belong to Tasks 8, 9, and 10.
- No claim that npm script execution is safe for an untrusted repository. The supported threat model is a user-trusted local workspace with a constrained outer runner.
- No portable process-tree termination, CPU/memory/network/file-system sandboxing, Windows junction protection for a future workspace adapter, binary signature verification, or preservation of arbitrary environment configuration.
