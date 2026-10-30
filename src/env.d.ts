/**
 * Compile-time build flags.
 *
 * `__DKS_TEST_SURFACE__` is substituted by the bundler's `define` (see
 * vite.config.ts and vitest.config.ts): `false` for every production build,
 * `true` only under Vitest. It is intentionally NOT a runtime check — the
 * test-only sheet table has to be removed from the shipped renderer by the
 * bundler's dead-code elimination, never merely hidden by CSS.
 */
declare const __DKS_TEST_SURFACE__: boolean;
