import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Sandboxes pass their own environment to `run()`, which would otherwise start a real daemon in
    // every test; the daemon tests opt in with VIA_NO_DAEMON=0 (daemonDisabled consults this too).
    env: { VIA_NO_DAEMON: '1' },
  },
});
