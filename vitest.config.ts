import { defineConfig } from 'vitest/config';

// CI runners — the 2-core Windows/macOS legs in particular — run the whole suite
// with far less headroom than a dev machine. The recorded CI evidence for the
// Workflow Profiles phase heads is a handful of 5000 ms test/hook timeouts in
// pre-existing, untouched tests (see docs/workflow-profiles/PHASE6_LIFECYCLE.md
// §7), i.e. worker starvation rather than a failing assertion. Per the owner
// instruction of 2026-09-30 the ceilings are raised on CI instead of chasing the
// flake; local runs keep Vitest's own defaults so a real hang still shows up fast.
export default defineConfig({
  test: {
    include: ['src/**/*.{test,spec}.ts'],
    environment: 'node',
    globals: false,
    ...(process.env.CI
      ? { testTimeout: 30_000, hookTimeout: 30_000, maxWorkers: 2 }
      : {}),
  },
});
