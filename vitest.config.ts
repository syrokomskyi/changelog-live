/*
<MODULE_CONTRACT>
<purpose>Configure Vitest testing framework for TypeScript project</purpose>
<non-goals>
  <item>Execute the tests themselves</item>
  <item>Provide test result analysis</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>Initial configuration setup for Vitest</item>
</CHANGE_SUMMARY>
*/

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    hookTimeout: 60000,
    testTimeout: 120000,
  },
});
