# HANDOFF — pi-prompt-analysis (ppa)

Prepared for a fresh-context session. Read this first; then [Todos](#future-session--todo) in order.

## Mission

Ship a pi extension (`ppa` / `pi-prompt-analysis`) that audits a fresh session's cold-start token overhead — system prompt, tool schemas, context injections — before/at the first LLM turn;; warms the prompt-cache prefix via one automatic "handshake hello" first turn;; presents results **non-sticky** (inline transcript card + console + one-line transient notify;; no widget/status/overlay。 Distributed from GitHub so other configs can `pi install git:github.com/nirguk/pi-prompt-analysis`.

## Repo state (as of latest handoff)

- Repo: **github.com/nirguk/pi-prompt-analysis** — public, branch `main`. Working tree clean; latest commit before handoff = "docs: handoff checkpoint".
- Files: `package.json` (pi manifest → `extensions/`, version `0.1.0`), `extensions/ppa.ts`, `README.md`, `LICENSE` (MIT), `.gitignore`, `HANDOFF.md`.
- Commit history after checkpoint: `3001a3a` (partial update, had problems) → `321a9d2` (clean-up) → `1949399` (docs trim). **The partial update left a syntax error** (`estimateTokens(m.chars}` missing `)` at line ~244 of the audit card) — fixed + smoke-tested in the current session, commit pending.

## What current ppa.ts does (verified working live)

3-phase audit via `pi.on(...)`:
- `session_start` → **"cold"**: per-tool definition sizes (top offenders first) + current messages (empty on fresh).
- first `before_agent_start` → **"payload"**: system-prompt breakdown by section (custom prompt, tool snippets, guidelines, appended prompt, context files, skills) + tools + messages + TOTAL BASELINE.
- first `turn_end` → **"usage"**: real provider usage (input/output/cost) + one-line transient notify (`ctx.ui.notify`, info) — non-blocking, TUI+RPC.
- Each phase: pretty **console block** + `pi.appendEntry("ppa:audit", …)` (NOT sent to LLM) + `pi.events.emit("ppa:audit", …)` (inter-extension channel) + inline **TUI transcript card** via `pi.registerEntryRenderer` (Box/Text, customMessageBg, handy "expand for full breakdown" hint; zero LLM tokens; nothing sticky/widget/overlay).
- Commands: `/ppa` re-runs "cold" on demand; `/ppa json` dumps latest audit as JSON.
- **Handshake = default-ON** on genuinely fresh interactive sessions only (`reason: "startup" | "new"`, never `resume`/`fork`; guarded by `ctx.hasUI`; disable via `--ppa-no-handshake` or env `PPA_HANDSHAKE=0`). Fires one "handshake hello" turn to warm the prompt-cache prefix + complete the audit.
- Verified: `pi -e extensions/ppa.ts -p "…"` in /workspaces/base_pi prints all three 🔍 blocks (tools 18/19 ≈ 43–44KB; system ≈15.7KB; TOTAL ≈59.4KB ≈14.9k tok; real usage ≈15.5k tok ≈$0.0018). Interactive-only paths (handshake fire, card render, notify) reviewed against docs/examples, not yet TUI-live-tested.

## Future session — TODO (in order)

~~1. Flip handshake to default-on~~ — **done** (flag `ppa-no-handshake`, env `PPA_HANDSHAKE=0`, `hasUI` + reason guards).
~~2. Transient notify on usage phase~~ — **done** (`ctx.ui.notify(…, "info")`, hasUI-guarded).
~~3. Inline transcript card~~ — **done** (`registerEntryRenderer` + Box/Text; matches `examples/extensions/entry-renderer.ts` pattern).
~~4. README refresh~~ — **done** (default-on framing: `--ppa-no-handshake` / `PPA_HANDSHAKE=0`; card + notify mentioned; install example pins `@v0.1.0`).
5. **Commit + tag**: pending in current session — one commit per logical change (ppa.ts paren fix; README; any HANDOFF trim), then `git tag v0.1.0 && git push origin main --tags` (README install example already pins `@v0.1.0`).
6. **(Optional, get user OK first)** Install into harness: `cd /workspaces/base_pi && pi install -l git:github.com/nirguk/pi-prompt-analysis` — project-local settings → auto-loads every harness session → auto-handshake each fresh session (recurring ≈15.5k tok ≈$0.002 warm-up each — confirm user accepts the recurring cost/habit before enabling). Alternatively keep it `-e`-manual or user-global.

## Open decisions (user

- Default-on handshake = every fresh session pays ≈15.5k-tok ≈$0.002 warm-up — user already approved default-on in principle;; re-flagthe recurring cost specifically for the base_pi install step (todo 6。
- Floating vs pinned git ref in README/install examples。
- Card styling details — user leans"nice" — tasteful, themed, compact (todo 3 suggestions are a starting point, not gospel。


## Reference (read before editing

- pi extension docs: `docs/extensions.md` + `examples/extensions/` under the pi install: `/usr/local/share/nvm/versions/node/v26.8.1/lib/node_modules/@earendil-works/pi-coding-agent/` (esp: `entry-renderer.ts`, `todo.ts`, `hello.ts`, `dynamic-tools.ts`。“
- Extension API essentials: `pi.registerTool`, `pi.registerCommand`, `pi.on`, `pi.registerFlag`, `pi.registerEntryRenderer`, `pi.appendEntry`, `pi.events`,`ctx.ui.notify`, `ctx.hasUI`, `ctx.sessionManager`。
