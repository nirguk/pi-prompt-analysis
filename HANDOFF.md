# HANDOFF — pi-prompt-analysis (ppa)

Prepared for a fresh-context session. Read this first; then [Todos](#future-session--todo) in order.

## Mission

Ship a pi extension (`ppa` / `pi-prompt-analysis`) that audits a fresh session's cold-start token overhead — system prompt, tool schemas, context injections — before/at the first LLM turn;; warms the prompt-cache prefix via one automatic "handshake hello" first turn;; presents results **non-sticky** (inline transcript card + console + one-line transient notify;; no widget/status/overlay。 Distributed from GitHub so other configs can `pi install git:github.com/nirguk/pi-prompt-analysis`.

## Repo state (at handoff time)

- Repo: **github.com/nirguk/pi-prompt-analysis** — public, branch `main`。
 Working tree = **clean**, at the verified-good version = commit **`94c677e`** (restored after a corrupt edit — see Gotcha below;; do not re-break it).
- Files: `package.json` (pi manifest → `extensions/`; pi-package keyword; peerDeps = core pi packages, `extensions/ppa.ts`, `README.md`, `LICENSE` (MIT), `.gitignore`, `HANDOFF.md` (this file. Latest commit = "docs: handoff checkpoint" (adds this file; code unchanged at v0).

## What v0 does (verified working live

3-phase audit via `pi.on(...)`:
- `session_start` → **"cold"**: per-tool definition sizes (top offenders first) + current messages (empty on fresh)。
- first `before_agent_start` → **"payload"**: system-prompt breakdown by section (custom prompt, tool snippets, guidelines, appended prompt, context files, skills) + tools + messages + TOTAL BASELINE.
- first `turn_end` → **"usage"**: real provider usage (input/output/cost。
- Each phase: pretty **console block** + `pi.appendEntry("ppa:audit", …)` (inline transcript card fodder; NOT sent to LLM; + `pi.events.emit("ppa:audit", …)` (inter-extension channel。
- Commands: `/ppa` re-runs "cold" on demand;; `/ppa json` dumps latest audit as JSON.
- Handshake = currently **opt-in** via `--ppa-handshake` (**intended: flip to default-on** — see Todos)。

## Future session — TODO (in order

1. **Flip handshake to default-on** — fire one"handshake hello" turn on fresh **interactive** sessions only (`reason: "startup" | "new"`, never `resume`/`fork`; guard **`ctx.hasUI`**;; disable via `--ppa-no-handshake` flag or env `PPA_HANDSHAKE=0`. (Do NOT send when `hasUI` false — print/rpc headless would spam.)
2. **Add transient notify** on the "usage" phase only: e.g. `PPA baseline captured: ~N tok (XKB) — card in transcript (scrollable), full detail on console`（`ctx.ui.notify(…, "info")`; non-blocking, TUI+RPC; nothing sticky).
3. **Add the inline transcript card** (user-leaning: "style it nicely"。 API verified from examples/extensions/entry-renderer.ts (+ todo.ts)：
   - `pi.registerEntryRenderer<AuditRecord>(AUDIT_ENTRY, (entry, { expanded }, theme) => Component)`;
   - Return a `new Box(1, 1, (t) => theme.bg("customMessageBg", t))` filled with `new Text(content, 0, 0)` children;
   - `theme.fg("accent"|"muted"|"dim"|"success", s)`; `theme.bold(s)`;; trim wide lines with `truncateToWidth(line, width)` (import from `@earendil-works/pi-tui` as todo.ts does)。
   - Suggested content: header line (🔍 PPA <PHASE> + timestamp, accent)、total row (bold accent big token figure + dim bytes)、section rows (muted,fixed labels: system/tools/messages + top trades)、expanded view (per-tool/per-message dim lines;; "· expand for the full breakdown" hint when collapsed;; expand only when there's detail。
   - Card = **TUI-only, zero LLM-token cost, scroll-past-able** — it lives inline in the transcript;; никогда widget/status/overlay/modal (user requirement: nothing sticky。
4. **Refresh README**: handshake now default-on (—ppa-no-handshake, PPA_HANDSHAKE=0;; card + notify mention;; remove outdated "opt-in"-era wording (README currently says "Passive audit (nothing else needed" + "With --ppa-handshake…" — rewrite to default-on framing.
5. **Commit + tag**: one commit per logical change;; then `git tag v0.1.0 && git push origin main --tags`(or `gh release create v0.1.0`;; and update README install example to pinned `@v0.1.0` — decide floating vs pinned (Open decisions。
6. **(Optional, get user OK first** Install into harness: `cd /workspaces/base_pi && pi install -l git:github.com/nirguk/pi-prompt-analysis` — project-local settings → auto-loads every harness session → auto-handshake each fresh session (recurring ≈15.5k tok ≈$0.002 warm-up each — confirm user accepts the recurring cost/habit before enabling. Alternatively keep it `-e`-manual or user-global.

## Open decisions (user

- Default-on handshake = every fresh session pays ≈15.5k-tok ≈$0.002 warm-up — user already approved default-on in principle;; re-flagthe recurring cost specifically for the base_pi install step (todo 6。
- Floating vs pinned git ref in README/install examples。
- Card styling details — user leans"nice" — tasteful, themed, compact (todo 3 suggestions are a starting point, not gospel。


## Reference (read before editing

- pi extension docs: `docs/extensions.md` + `examples/extensions/` under the pi install: `/usr/local/share/nvm/versions/node/v26.8.1/lib/node_modules/@earendil-works/pi-coding-agent/` (esp: `entry-renderer.ts`, `todo.ts`, `hello.ts`, `dynamic-tools.ts`。“
- Extension API essentials: `pi.registerTool`, `pi.registerCommand`, `pi.on`, `pi.registerFlag`, `pi.registerEntryRenderer`, `pi.appendEntry`, `pi.events`,`ctx.ui.notify`, `ctx.hasUI`, `ctx.sessionManager`。
