# Mobile web adaptation implementation plan

**Goal:** Add the approved mobile Inbox and dedicated conversation, file, and model pages to Nero Agent web.

**Architecture:** Reuse the current authenticated AgentShell context and existing data clients. Add mobile-only views and route them from App; scope CSS under the mobile shell and breakpoint.

**Tech Stack:** React 19, React Router 7, TypeScript, Vite, Vitest, CSS.

**Spec:** `docs/superpowers/specs/2026-10-16-mobile-web-adaptation-design.md`

## Tasks

1. Add mobile shell and route selection, with tests for navigation and desktop fallbacks.
2. Add Inbox cards, recent source switch, and composer wiring, with interaction tests.
3. Add history, files, and models pages using existing data services, with empty/error tests.
4. Adapt chat and composer layout for mobile, then run the full web test and build scripts and inspect the result.
