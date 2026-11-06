// Vitest config for the 30k-point oracle check (assets/proximity/oracle30k.check.ts); not part of npm test.
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { globals: true, environment: 'node', include: ['assets/proximity/oracle30k.check.ts'] } });
