import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  {
    ignores: ["**/node_modules/**", "**/dist/**", "coverage/**", "sample-repo/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
      eqeqeq: ["error", "always"],
      "no-console": ["error", { allow: ["error", "warn"] }],
    },
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    rules: { "@typescript-eslint/no-require-imports": "off", "no-console": "off" },
  },
  {
    files: ["**/test/**/*.ts"],
    rules: { "no-console": "off" },
  },
  prettier,
);
