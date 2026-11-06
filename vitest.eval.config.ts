import { defineConfig } from 'vitest/config';
// Opt-in chat eval (npm run eval:chat); `npm test` never includes *.eval.ts.
export default defineConfig({
  test: { globals: true, environment: 'node', include: ['assets/agent/**/*.eval.ts'], testTimeout: 3_600_000 }
});
