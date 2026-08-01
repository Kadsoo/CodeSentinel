// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { App } from "./App.js";

describe("CodeSentinel public mock demo", () => {
  it("shows governance, redacted feedback, and credential-safe boundaries", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "CodeSentinel" })).toBeTruthy();
    expect(screen.getByText(/POLICY_DENIED/u)).toBeTruthy();
    expect(screen.getByText(/\[REDACTED\]/u)).toBeTruthy();
    expect(screen.getByText(/下一步动作：propose_patch/u)).toBeTruthy();
    expect(screen.getByText("公开演示不会读取或接收 API Key")).toBeTruthy();
  });
});
