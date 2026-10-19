import { defineConfig } from 'vitest/config';

// A tesztelt modulok tiszta logika (nincs DOM), ezért node környezet elég.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'electron/**/*.test.ts']
  }
});
