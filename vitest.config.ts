import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Many tests spawn real subprocesses (stdio mock servers, the built CLI);
    // the 5 s default times out on a loaded machine.
    testTimeout: 20_000,
  },
});
