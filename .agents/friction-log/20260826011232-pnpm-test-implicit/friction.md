---
title: 'pnpm test implicit install blocked'
severity: 'minor'
---

In the pi-interactive-shell task worktree, running pnpm test with no node_modules caused pnpm 11 to run an implicit install. It downloaded packages but exited non-zero because build scripts were ignored (ERR_PNPM_IGNORED_BUILDS), so focused tests did not start. Reproduction: fresh worktree without node_modules; run pnpm test -- tests/dispatch-auto-exit.test.ts.
