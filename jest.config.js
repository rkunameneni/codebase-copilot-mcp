/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "node",
  roots: ["<rootDir>/packages"],
  testMatch: ["**/test/**/*.test.ts"],
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "<rootDir>/tsconfig.test.json" }],
  },
  moduleNameMapper: {
    "^@codebase-copilot/(rag|mcp-server|agent)$": "<rootDir>/packages/$1/src/index.ts",
  },
  // CLIs are exercised end to end in CI (stdio smoke test, search and review --dry-run);
  // barrels only re-export.
  collectCoverageFrom: [
    "packages/*/src/**/*.ts",
    "!packages/*/src/cli.ts",
    "!packages/*/src/index.ts",
  ],
  coverageReporters: ["text-summary", "lcov"],
  coverageThreshold: {
    global: { statements: 90, branches: 75, functions: 90, lines: 90 },
  },
  testTimeout: 20000,
};
