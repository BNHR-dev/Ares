# Ares Architecture

The map for "I want to tackle X — where does it live?" Every area below is
independently assessable: each package typechecks alone via project
references (`pnpm --filter <pkg> exec tsc -b --pretty false`), and the big
files are split into domain modules behind **facade barrels** — the original
file path always re-exports its full surface, so imports (and the root tests
that pin compiled `dist/` paths) never break.

## The monorepo

| Package | What it is |
| --- | --- |
| `packages/core` | Engine room: `QueryEngine` (streaming turn loop), providers, sessions, checkpoints, verifier, conductor (fleets), memory/mind |
| `packages/cli` | The product: terminal UIs, the **daemon** that the desktop app drives, provider routing, Vanguard drive host |
| `packages/tools` | The tool belt: Edit/Read/Bash/Grep/Browser/ComputerUse/MCP/LSP…, shared tool framework in `_shared.ts` |
| `packages/protocol` | Wire types + secret redaction (small, stable) |
| `packages/garrison` | Background autonomy server (WS sessions, approvals) |
| `packages/channels` | Telegram bridge |
| `tauri/` | Desktop shell (Rust) + React UI (`tauri/src` — see `tauri/src/ARCHITECTURE.md`) |
| `vendor/vanguard` | Vendored compiled Vanguard engine (synced by `scripts/sync-vanguard.mjs`; never hand-edit) |

## Where to go, by job

- **Routing (lanes, auto-routing, dead providers)** → `packages/cli/src/entry/daemon/routing.ts` (lane tables + command normalization); the sticky-lane turn logic lives in `entry/daemon.ts`'s send path; core lane classifier: `packages/core/src/modelRouter.ts`.
- **Model discovery / provider selection** → `packages/cli/src/entry/providers/` — `catalog.ts` (per-provider model discovery incl. Kimi via the vanguard dynamic import), `select.ts` (provider construction + preflights + MoA), `gatewayClient.ts` (Ares in-house gateway HTTP), `types.ts` (provider taxonomy, lanes, ensembles). Provider wire adapters themselves: `packages/core/src/providers/*`.
- **Vanguard drive mode** → `packages/cli/src/entry/vanguard/` — `drive.ts` (engine session lifecycle, event translation to daemon vocabulary, approval bridge, durable session binding) and `engineLoader.ts` (worker CLI resolution; OTA dir outranks bundled). OTA updates: `entry/vanguardEngineUpdate.ts`. Publish flow: `scripts/sync-vanguard.mjs` then `scripts/publish-vanguard-engine.mjs`.
- **OAuth / sign-in flows** → daemon handlers in `entry/daemon.ts` (anthropic/openai/kimi login commands); core flows: `packages/core/src/providers/anthropicAuth.ts`, `openaiAuth.ts`; Kimi rides the vendored vanguard engine.
- **Skills** → `packages/cli/src/entry/daemon/skills.ts` (SKILL.md parsing, surfaces, provides inference).
- **Permissions** → `packages/cli/src/policyGate.ts` + `permissionPolicy.ts` + `entry/permissions.ts`; path/command grants: `packages/tools/src/_shared.ts` (`resolveWorkspacePath` — outside-workspace paths raise approval cards, never hard walls).
- **Prompts (system prompt, reach doctrine)** → `packages/cli/src/entry/turnPipeline.ts` (`buildSystemPrompt`). Vanguard's own prompts live in the engine repo (`inference/codecs/shared.ts`).
- **Coding process (turn loop, compaction, tool execution)** → `packages/core/src/queryEngine.ts`; verification: `packages/core/src/verifier.ts`; checkpoints/undo: `packages/core/src/checkpoints.ts`.
- **Usage/cost stats** → `packages/cli/src/entry/daemon/usageStats.ts`.
- **UI** → `tauri/src/` (its own ARCHITECTURE.md maps state/, components/, models/).
- **Engine config knobs** → `packages/cli/src/entry/daemon/engineConfig.ts` (env-backed knobs, applied live).

## Contracts that keep refactors safe

1. **Facade doctrine**: splitting a big file always leaves the original path
   as a barrel re-exporting its full surface. Root tests import compiled
   `packages/cli/dist/entry/{daemon,providers,sessionFactory,turnPipeline,browserBridge}.js`
   and a dozen `dist/` module paths — those paths are API.
2. **The daemon NDJSON protocol is the desktop app's API.** Command/event
   names and shapes in `entry/daemon.ts` are consumed by `tauri/src/App.tsx`
   and `tauri/src-tauri/main.rs`; new commands must be allowlisted in
   `main.rs` (`ALLOWED_DAEMON_COMMANDS`).
3. **The packaged runtime is what actually runs.** The desktop app spawns the
   daemon from `tauri/src-tauri/runtime/cli/ares-cli.mjs` (esbuild bundle,
   inlines vanguard) — after daemon/vanguard changes run `pnpm build:runtime`
   in `tauri/` and copy over `src-tauri/target/debug/runtime` for dev.
4. **Never `git add` whole files in a dirty tree** — stage hunks. Verify the
   committed tree in the `D:\ares-ci-check` worktree (`pnpm install && pnpm check`)
   before tagging a release.
5. **`vendor/vanguard` is generated** — change the engine in `D:\Vanguard`,
   then sync + publish to the `vanguard-engine` OTA channel (rolling GitHub
   release). Installed apps update the engine without an app release.

## Checks

- Typecheck everything: `pnpm check` (root, `tsc -b` over project references).
- Typecheck one area: `pnpm --filter @ares/core exec tsc -b --pretty false`.
- Full suite: `pnpm test` (root `tests/*.test.mjs` — they exercise compiled dist).
- There is intentionally no lint config yet; `check` = types. If adding one,
  exclude `vendor/`, `dist/`, `tauri/src-tauri/`, and mind the BOM-prefixed
  json files (formatters create churn against live WIP).

## Known cores that stay whole (do not split)

- `packages/core/src/queryEngine.ts` `streamTurn` — the turn loop's phases
  share state deliberately; extract leaf helpers only, behind the facade.
- Frozen while user WIP is live: `packages/core/src/{session,codingJournal,frictionLog,index}.ts`,
  `packages/cli/src/entry/{entry,garrisonCmd,runtime,turnPipeline}.ts`,
  `packages/garrison/src/sessions.ts`, `packages/protocol/src/secretRedact.ts`,
  `packages/channels/src/telegram/scheduler.ts` (+ untracked triage/registry files).
