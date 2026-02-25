import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // jsdom gives us DOMParser (used by parsePcText and buildWeekHints in domain/outline.ts)
    environment: 'jsdom',
    // Show individual test names in output
    reporter: 'verbose',
  },
});
