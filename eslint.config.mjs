import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "**/dist/**",
      "coverage/**",
      ".worktrees/**",
      "fixtures/**/node_modules/**",
      "**/*.db",
      "**/*.sqlite",
      "**/*.log"
    ]
  },
  js.configs.recommended,
  tseslint.configs.recommended
);
