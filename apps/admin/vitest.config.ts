import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // `forbidden()` (next/navigation) only emits the real 403 routing
    // interrupt when auth interrupts are enabled. Next sets this from
    // `experimental.authInterrupts` at build time; mirror it here so the S2
    // test exercises the true 403 path rather than the "experimental" guard.
    env: {
      __NEXT_EXPERIMENTAL_AUTH_INTERRUPTS: "true",
    },
  },
});
