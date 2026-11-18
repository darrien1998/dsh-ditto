import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.spec.ts'],
    // The integration suites mount the real Cordis + ToolRuntime host and do real
    // file I/O across hundreds of files, so on a loaded or virus-scanning machine
    // they legitimately exceed Vitest's 5 s default. The unit suites finish in
    // milliseconds either way, and the slowest acceptance test sets its own
    // larger budget explicitly.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
