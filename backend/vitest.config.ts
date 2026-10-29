import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Each test file starts its own in-memory database (WebAssembly). On a busy computer, with the dashboard also running,
    // that can take longer than the 10 second default.
    hookTimeout: 60_000,
  },
});
