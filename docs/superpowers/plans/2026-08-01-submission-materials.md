# Course Submission Materials and Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make CodeSentinel match the AI4SE Project A delivery checklist by adding an honest README, a student-editable reflection draft, reproducible CI, distribution instructions, and a static Mock WebUI demonstration.

**Architecture:** Keep the existing local API/CLI and security boundaries unchanged. Add a small React/Vite `apps/web` package whose default build is a deterministic, credential-free Mock demonstration; keep real local API use an explicit opt-in path documented in the README. Add CI definitions that run the existing root test/typecheck/lint/build commands and expose the required `unit-test` job.

**Tech Stack:** TypeScript, React, Vite, Vitest, npm workspaces, GitHub Actions, GitLab CI syntax, GitHub Pages static deployment.

---

### Task 1: Establish the material checklist and branch evidence

**Files:**
- Create: `docs/superpowers/plans/2026-08-01-submission-materials.md`
- Modify: `PLAN.md`
- Modify: `AGENT_LOG.md`

- [x] **Step 1: Record the exact course checklist**

Capture the required files, CI job name, final-pass evidence, deployment URL, and Project A mock-LLM/demo additions in this plan. Explicitly record that `REFLECTION.md` is a student-owned draft until edited by the student.

- [x] **Step 2: Audit the current tree**

Run `rg --files -g 'README*' -g 'REFLECTION.md' -g '.gitlab-ci.yml' -g '.github/**' -g 'Dockerfile*'` and record missing artifacts in `AGENT_LOG.md`.

- [x] **Step 3: Commit the plan**

Run `git add docs/superpowers/plans/2026-08-01-submission-materials.md PLAN.md AGENT_LOG.md` and commit the plan/evidence before implementation.

### Task 2: Add a deterministic React Mock WebUI

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/web/index.html`
- Create: `apps/web/src/main.tsx`
- Create: `apps/web/src/App.tsx`
- Create: `apps/web/src/styles.css`
- Create: `apps/web/src/App.test.tsx`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Write the failing UI test**

Add a jsdom test that renders `<App />` and asserts the deterministic demo shows the CodeSentinel title, a redacted timeline entry, a denied dangerous action, a feedback-driven next action, and a disabled credential display. Run `npm test -- --run apps/web/src/App.test.tsx`; it must fail because `apps/web/src/App.tsx` does not exist.

- [ ] **Step 2: Implement the minimal static Mock demo**

Implement `App` with typed in-memory demo data only. Render three panels: session status, event timeline, and governance evidence. Do not read `window.localStorage`, environment variables, URLs, files, or credentials. Add a visible notice that the public demo never runs code and never accepts a key. `main.tsx` mounts the app and `styles.css` provides a readable responsive layout.

- [ ] **Step 3: Add Vite scripts and workspace metadata**

Add `apps/web` to npm workspaces with `dev`, `build`, and `preview` scripts. Keep the root `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build` commands working. Use the existing React/Vite dependencies and update the lockfile with `npm install --package-lock-only`.

- [ ] **Step 4: Run the focused and full checks**

Run `npm test -- --run apps/web/src/App.test.tsx`, then `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build`. The focused test must pass and the full suite must have zero failures.

- [ ] **Step 5: Commit the WebUI**

Run `git add apps/web package.json package-lock.json` and commit `feat: add deterministic mock web demo`.

### Task 3: Add packaging, CI, and Pages deployment configuration

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/pages.yml`
- Create: `.gitlab-ci.yml`
- Create: `scripts/mechanism-demo.ts`
- Modify: `package.json`

- [ ] **Step 1: Add the offline mechanism demo test first**

Add `scripts/mechanism-demo.test.ts` with assertions over a deterministic function that returns three proof records: `POLICY_DENIED` with zero tool calls, a failed verification followed by a changed next action, and a patch whose approval/base hash is required before apply. Run the focused test and observe the missing demo module failure.

- [ ] **Step 2: Implement the mechanism demo**

Implement `scripts/mechanism-demo.ts` as a no-network script using existing contracts/policy abstractions and stable JSON output. It must never read a real key, execute a shell command, write a workspace file, or contact a provider. Add `demo:mechanisms` to the root scripts.

- [ ] **Step 3: Add CI definitions**

GitHub Actions `ci.yml` runs on push and pull request with Node 22.17.0, `npm ci`, `npm run test`, `npm run typecheck`, `npm run lint`, and `npm run build`. GitLab CI defines a `unit-test` job with the same `npm ci` and `npm test` commands. Pages workflow builds `apps/web` and deploys only the static `apps/web/dist` artifact.

- [ ] **Step 4: Add a safe container recipe**

Use a multi-stage Dockerfile that installs dependencies with `npm ci`, builds the static web demo, and serves it from an unprivileged Node process using a minimal static server command documented in the README. Do not copy `.env`, databases, credentials, or workspaces into the image.

- [ ] **Step 5: Verify CI and packaging files**

Run `npm run demo:mechanisms`, `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, and `git diff --check`. Inspect CI YAML for the required `unit-test` job and for no secret values.

- [ ] **Step 6: Commit CI and packaging**

Run `git add Dockerfile .dockerignore .github .gitlab-ci.yml scripts package.json package-lock.json` and commit `ci: add reproducible checks and demo packaging`.

### Task 4: Write the submission README and reflection draft

**Files:**
- Create: `README.md`
- Create: `REFLECTION.md`
- Modify: `AGENT_LOG.md`

- [ ] **Step 1: Write README from the implemented behavior**

Document the project purpose, local-first architecture, Windows prerequisites, `npm ci`, local API/CLI commands, deterministic Mock WebUI, mechanism demo, provider credential safety, distribution options, CI commands, directory layout, known limitations, and the distinction between the local API and the public static Mock demo. Do not claim a live URL until Pages has actually published one.

- [ ] **Step 2: Add the student-editable reflection draft**

Create a 1500–2500 Chinese-character draft covering Superpowers skills, TDD, subagent granularity, spec quality, prompt/context strategy, credential/distribution lessons, limitations, and what would change on a second attempt. Start the file with a clear `初版草稿：提交前必须由学生本人核对、重写并标注 AI 辅助润色` notice.

- [ ] **Step 3: Verify documentation links and claims**

Check every command and path against the repository. Search for accidental key-like strings, `.env` references that are not documentation examples, and claims of a live deployment before one exists.

- [ ] **Step 4: Commit the materials**

Run `git add README.md REFLECTION.md AGENT_LOG.md` and commit `docs: add course submission materials`.

### Task 5: Final evidence, review, and handoff

**Files:**
- Modify: `AGENT_LOG.md`

- [ ] **Step 1: Run the complete verification matrix**

Run `npm ci`, `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm run demo:mechanisms`, and `git diff --check origin/main...HEAD`. Record exact results and any skipped platform tests.

- [ ] **Step 2: Review the delivery checklist**

Confirm that SPEC/PLAN/SPEC_PROCESS, source/PR history, README, AGENT_LOG, REFLECTION draft, CI files, packaging files, WebUI source, mechanism demo, and no-secret scan are present. Mark the deployment URL as pending until the Pages workflow produces a public URL.

- [ ] **Step 3: Record factual evidence**

Append a timestamped AGENT_LOG entry with commit hashes, test counts, CI configuration, Pages status, and the remaining student-owned reflection edit.

- [ ] **Step 4: Commit final evidence**

Run `git add AGENT_LOG.md` and commit `docs: record submission material verification`.
