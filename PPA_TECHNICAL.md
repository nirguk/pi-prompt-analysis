# ppa — Technical Reference

Authoritative, maintainer/agent-facing documentation for **pi-prompt-analysis
(ppa)**. The [README](README.md) is the user guide; this file covers *how it
works*: architecture, the audit record model, measurement methodology,
rendering rules, the terminology glossary, the design decisions behind the
current shape, and how to verify changes.

This file supersedes `PPA-HANDOFF.md` (a session handoff that lived in the
workspace). Everything it recorded as "open" was resolved and is now captured
in the glossary (§7) and design-decisions (§8) sections below.

---

## 1. Architecture

ppa hooks two session events and emits **two audit phases** per session:

| Phase | Hook | Captures |
|-------|------|----------|
| `payload` | first `before_agent_start` | The full pre-LLM payload: system prompt (split into six sections), per-tool schema sizes, session messages → `TOTAL BASELINE` |
| `usage` | first `turn_end` whose assistant message carries provider usage | Real provider token numbers for that first round-trip — full input accounting (`cache-read` + fresh split), plus the measured payload's share of it |

`session_start` is a *transitional* hook: it records the start reason code
(`startup`/`new`/`resume`/`fork`/`reload`) for the payload record and arms
the optional handshake. It no longer emits an audit — an earlier third phase
(`cold`) measured tools + messages at `session_start`, but the payload phase
fully contains that measurement, so it was removed (see §8, "Cold phase
removed").

Each phase, in order:

1. logs a pretty block to the console,
2. persists a `ppa:audit` **custom entry** in the session (never sent to the LLM),
3. renders an inline **transcript card** in the TUI (payload and usage alike),
4. emits the record on `pi.events` as the `"ppa:audit"` event for
   inter-extension consumers.

`payload` and `usage` each report **once** per session (guarded by
`payloadLogged` / `usageLogged` flags). `/ppa` re-runs a payload audit on
current state (stamped `reason: "manual"`).

## 2. Data model

Every audit produces an `AuditRecord` (the same object is persisted,
rendered, and emitted):

```ts
interface AuditRecord {
  phase: "payload" | "usage";
  at: string;                         // ISO timestamp of the audit
  reason?: string;                    // payload: session-start reason, or "manual" for /ppa
  sessionFile?: string;               // session path (when available)

  // ---- payload phase ----
  systemChars?: number;               // measured chars of the built system prompt
  systemSections?: AuditSection[];    // the six sections, each { label, chars }
  tools?: AuditTool[];                // per-tool schema size, sorted desc by chars
  messageCount: number;
  messages?: AuditMessage[];          // { index, role, chars }
  totalChars?: number;                // system + tools + messages → TOTAL BASELINE

  // ---- usage phase ----
  payloadChars?: number;              // measured chars of the payload text (copied from the payload record)
  inputChars?: number;                // measured chars of the full input text (payload + prior non-assistant messages)
  outputChars?: number;               // measured chars of the assistant message
  payloadEstTokens?: number;          // payloadChars ÷ 4 (estimate, tokens)
  payloadSharePct?: number;           // payload estimate as % of the real first-turn input tokens
  handshakeSent?: boolean;            // whether the non-payload input text is the automatic handshake turn
  usage?: RawUsage;                   // provider usage, as-reported
}
```

`RawUsage` is a loose structural shape tolerating provider variants
(`input`/`input_tokens`, `output`/`output_tokens`, `cacheRead`, `cacheWrite`,
`reasoning`, `totalTokens`, `cost: { total | total_cost }`, `cost_usd`).
The native pi `Usage` type satisfies it without casts.

### Where the record lives

- **Console**: full block, including the raw `Usage:` JSON on the usage phase.
- **Session**: `ppa:audit` custom entry (`data` = the record). `customType` is
  `"ppa:audit"`; type is `"custom"`. Never part of the LLM payload.
- **Events**: `pi.events.on("ppa:audit", (record) => …)`.
- **Many**: `/ppa json` notifies the latest record + count; the card shows the
  friendly subset.

## 3. Measurement methodology

Every number in ppa is either **measured chars** (text actually countable) or
**real provider tokens** — never a mix. The only heuristic in the whole
package is `chars ÷ 4` for estimates, always marked with `~`.

### Payload phase

- **Tool size** = `JSON.stringify({ description, parameters })` of each tool
  (via `pi.getAllTools()`), summed and per-tool.
- **Message size** = `JSON.stringify()` of the full message object, from
  `sessionManager.buildContextEntries()` (type `"message"` only).
- **System prompt chars** = `event.systemPrompt.length` — the exact built
  text at `before_agent_start`.
- **Six sections** = serialized sizes of the six `BuildSystemPromptOptions`
  fields (see §6). Each records only its *size* — never the text — to stay
  passive.
- **`TOTAL BASELINE`** = `systemChars + toolsChars + messagesChars`.

### Usage phase

- Providers report `input` as the **non-cached** tokens only; the cached
  prefix arrives separately as `cacheRead`. **Full input**
  `= input + cacheRead` (`totalInputTokens`). The card/console always reason
  about the full input, never provider `input` alone.
- **Chars are measured, not derived**: input chars = the payload record's
  `totalChars` + the session's non-assistant messages at `turn_end`
  (normally just the handshake user turn, 94 chars). Output chars = the
  serialized assistant message just produced. The `tokens × 4` heuristic only
  kicks in as a fallback when the payload record is unavailable.
- **`payloadSharePct`** = `estimateTokens(payloadChars) / fullInputTokens`,
  rounded — labeled "of input tokens" on the card. The real tokenizer runs
  denser than 4 chars/token (~3.8 for a typical session), which is why the
  same payload ≈ 96% of input *tokens* but ≈ 100% of input *chars*.

### Formatting rules (fixed, never per-row)

- Sizes always in **K-chars** (`÷1000`), tokens in **K-tokens**; exactly one
  decimal place, thousands separators on the integer part, zero → `0.0`.
  Scale is never re-scaled per row (900 → `0.9 K-chars`, 1,234,567 →
  `1,234.6 K-chars`).
- `~` prefixes **guesstimates** (chars ÷ 4). Real provider numbers never get
  `~`.
- **Share column**: each row's `%` of the payload total
  (`round(chars/total × 100)`, only shown when `> 0`), right-aligned; rows
  without a share get a blank cell of the same width so the column stays
  uniform.

## 4. Rendering & UI

### Console

Payload block: header (`🔍 [PPA: payload] (ISO)`), `reason:`, `session:`,
`System Prompt:` + sections, `Tools (N):` + per-tool rows, `Messages (N):`,
`TOTAL BASELINE:` — all rows through the shared `alignCells` machinery so
decimal points line up. Usage block adds the `Input:`/`Payload:`/`Output:`
table, `Cost:`, `Billing:`, and the raw `Usage:` JSON.

### Transcript card

- One card per audit. **Collapse/expand is platform-owned** — click the card,
  or `app.tools.expand` (`ctrl+o`, rebindable in
  `~/.pi/agent/keybindings.json`); transcript blocks implement
  `setExpanded(...)` and `setToolsExpanded` walks all of them, so `ctrl+o`
  toggles ppa cards exactly like tool blocks. No extension code toggles
  anything; there is deliberately **no custom per-card shortcut**
  (transcript blocks get no `handleInput`).
- **Reason line** (`reason: startup` …) renders above the table in **both**
  collapsed and expanded states — one shared code path, no duplication.
- **Payload collapsed = teaser** (no timestamp): `TOTAL:` row with `▾`, top
  tool (with share), top section (with share), then
  `· N tools · N sections ▾`. The `▾` affordance marks collapsed-ness.
- **Payload expanded = full unfurl**: header gains a dimmed short time
  (`🔍 PPA PAYLOAD  12:43:20`), then headline total, every section/tool/
  message row with share, no `▾`. Length caps (30 tools / 15 messages) exist
  only as safety valves for pathological sessions — never a second summary.
- **Usage is always-full**: collapsed ≈ expanded (no detail gating);
  `Input:` is the bold anchor, `Payload:` nests under it, `Output:` is a peer
  row. `totalTokens` stays on the console line and `/ppa json`, not the card.

## 5. Session flow & the handshake

`session_start` sets `sessionReason = event.reason`. On **genuinely fresh
sessions with UI** (`reason: "startup" | "new"`, and `ctx.hasUI`, which is
true in TUI and RPC modes) the extension queues one automatic
`handshake hello` user turn — never on `resume`/`fork`/`reload`, never in
print/json modes (`ctx.hasUI` false). The handshake warms the prompt-cache
prefix and completes both phases before the user types; it is the reason the
usage card can label its non-payload input row `· handshake msg:`.

Disable: `pi --ppa-no-handshake` or `PPA_HANDSHAKE=0 pi` (any value other
than `"0"` leaves it enabled).

The audit is otherwise **passive**: it only hooks events and never modifies
the LLM payload.

## 6. The six system-prompt sections

The payload phase splits the system prompt into the same six sections the
agent itself builds (`BuildSystemPromptOptions` in pi's
`dist/core/system-prompt.d.ts`, populated by `agent-session.js` →
`ResourceLoader`). ppa records each section's **size only** (chars), never
its text.

| Section | What it is | Where it comes from |
|---|---|---|
| `custom prompt` | Replaces the whole default system prompt | CLI `--system-prompt <text>`; auto-discovered `.pi/SYSTEM.md` (project, when trusted) or `~/.pi/agent/SYSTEM.md`; extension `systemPromptOverride` |
| `tool snippets` | One-line `- name: <snippet>` per enabled tool | Each active tool's registered snippet (`registerTool`); `agent-session.js` collects them per enabled tool (`_toolPromptSnippets`) |
| `guidelines` | Extra guideline bullets merged into the default `Guidelines:` section | Tool definitions' `promptGuidelines` + session instructions |
| `appended prompt` | Verbatim text appended after the system prompt | CLI `--append-system-prompt <text>`; auto-discovered `.pi/APPEND_SYSTEM.md` / `~/.pi/agent/APPEND_SYSTEM.md` |
| `context files` | Pre-loaded file contents (`{path, content}`) rendered as `Context files:` | The AGENTS/CLAUDE chain: `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD` — global `~/.pi/agent/AGENTS.md` up through ancestor project dirs |
| `skills` | Pre-loaded skills (name, description, `SKILL.md` instructions) | Skill dirs `~/.pi/agent/skills`, `.pi/skills`, installed packages; settings `skills` paths |

**How to observe the content**: per-section, read the file/flag/skill dir
listed above. Programmatically, `ctx.getSystemPromptOptions()` (command
handler context) returns all six fields; `event.systemPrompt` at
`before_agent_start` is the exact built text ppa measures as
`System Prompt:` (it also lands in the session file's pre-LLM payload entry).

## 7. Glossary (terminology as agreed)

| Term | Definition |
|---|---|
| **payload phase** | The audit at the first `before_agent_start`: the full pre-LLM text (system prompt + tool schemas + messages). *This is the cold-start audit* — there is no separate cold snapshot. |
| **usage phase** | The audit at the first `turn_end` with provider usage: real billed tokens for the first round-trip. |
| **cold phase** (removed) | A former third phase at `session_start` measuring tools + messages; the payload fully contained it, so it was dropped. Historical records still render (as a payload-style unfurl). |
| **Δ vs COLD** (removed) | A payload row that was `payloadTotal − coldTotal` — literally the System Prompt row re-rendered (the only payload-only component). Dropped with the cold phase. |
| **reason code** | `startup`/`new`/`resume`/`fork`/`reload` from `session_start`, or `manual` for `/ppa`; shown on the payload card above the table in both states. |
| **TOTAL BASELINE** | The payload total: `systemChars + toolsChars + messagesChars` (chars). |
| **chars** | Units of all measurements — `JSON.stringify(...).length`. |
| **K-chars / K-tokens** | Fixed-scale display: `÷1000`, one decimal place, thousands separators, zero → `0.0`. Never re-scaled per row. |
| **`~` (tilde)** | Marks an **estimate** (chars ÷ 4). Real provider numbers never carry `~`. |
| **share column** | Each row's `%` of the payload total, right-aligned, blank cell for share-less rows. Shown on every console row and expanded card. |
| **`· handshake msg:` / `· user msg:`** | The usage-card row for the non-payload input text. `handshake msg:` when the record's `handshakeSent` flag is set (input warmed by the automatic turn), else `user msg:`. |
| **Input (full)** | `input + cacheRead` — the whole pre-LLM stream actually sent. Providers report `input` as non-cached-only; ppa never quotes provider `input` alone. |
| **cache-read / cache-write / fresh / reasoning** | Provider token buckets: cached prefix hit, cached write, non-cached input, reasoning output. |
| **payloadSharePct / `≈ N% of input tokens`** | Payload estimate ÷ full input tokens — the payload's share of the first real round-trip. |
| **measured vs derived** | Chars are measured (payload record + session messages + serialized assistant message); tokens are real from the provider. `chars × 4`/`tokens × 4` only as fallback. |
| **handshake** | The one automatic `handshake hello` user turn on fresh UI sessions that warms the prompt-cache prefix and completes both phases. |
| **`ppa:audit` entry / event** | The custom session entry (persisted, never sent to the LLM) and the `pi.events` event — same `AuditRecord` object. |
| **`/ppa` / `/ppa json`** | Re-run a payload audit on current state (`reason: manual`) / notify the latest record as JSON. |

## 8. Design decisions (resolved)

The card/console details were settled iteratively; the current behavior
implements these agreements:

- **Teaser vs unfurl**: collapsed payload = `TOTAL:` anchor + top tool +
  top section + counts (no timestamp); expanded = full unfurl (headline,
  every row with share). Caps are safety valves only.
- **Usage always-full**: no collapsed/expanded distinction; `Input:` bold
  anchor, `Payload:` nested, `Output:` peer; billing always visible;
  `totalTokens` not on the card (console + `/ppa json` keep it).
- **Share column on both console and expanded card**, including payload
  rows. Weightless rows leave a blank cell so the column stays uniform.
- **`▾` collapsed-only** (expanded is unmissable without it).
- **Timestamp**: none in the teaser; expanded header shows a dimmed short
  time, outside the aligned data block.
- **Keyboard**: platform-owned only — `ctrl+o`/click toggles cards via
  `setExpanded`; no extension-invented per-card binding (not possible for
  transcript blocks, and not needed). Rebindable in keybindings.json.
- **Cold phase removed**: the payload fully contains the old cold
  measurement (`tools + messages` — the only extra payload piece is the
  system prompt, which is exactly what Δ vs COLD re-rendered). Dropping it
  removed the duplicate console block, the Δ row, and the
  cold-vs-payload/delta bookkeeping — one record shape, one renderer, less
  documentation. The reason code moved onto the payload record (shared
  card line, both states) to keep the session-provenance info.
- **`/ppa` re-runs payload**: same record shape and renderer as the
  automatic phase (stamped `reason: "manual"`), using
  `ctx.getSystemPromptOptions()` + `ctx.getSystemPrompt()`.

## 9. Verification

No TypeScript compiler in the environment — verification is a triple:

1. `node scripts/verify-format.ts` — fixed-value formatter checks + the
   alignment invariant: every decimal point in the K-chars and K-tokens
   columns lands on the same character offset in every row (also covers the
   share column: rendered cell, blank cell for shareless rows, widest
   right-aligned, uniform start column).
2. `node scripts/gen-readme-block.ts` — regenerates the README's sample
   console block from the real session numbers (writes `/tmp/readme-block.txt`).
3. `/tmp/ppacheck/harness.mjs` — loads the **real** session records from
   `/workspaces/base_pi/.pi/sessions/…/2026-09-07T12-43-19-….jsonl` and drives
   a copy of `ppa.ts` (with a test-only `__test = { emit, usageNumbers,
   totalInputTokens, renderAuditCard }` export appended) through payload/
   usage console + card paths, collapsed and expanded.

To re-run the harness after editing: `cp extensions/ppa.ts /tmp/ppacheck/
ppa.ts`, append the `__test` export, `node /tmp/ppacheck/harness.mjs`. The
**repo file must never contain** the `__test` export. Keep
`/tmp/ppacheck/lib/format.ts` in sync with `extensions/lib/format.ts`.

## 10. Known limitations

- `node` emits `MODULE_TYPELESS_PACKAGE_JSON` warnings when running the
  scripts (no `"type": "module"` in package.json) — harmless, reparsed as ESM.
- No real `tsc --noEmit`; verification is parse+runtime via type stripping.
- `expanded` is injected by the platform; the harness passes it explicitly
  for both states. Unknown defaults in some builds could differ.
- The handshake (94 chars) wrinkle: with a ~3.8 chars/token real tokenizer,
  the payload is ≈100% of input *chars* but ≈96% of input *tokens* — hence
  the "of input tokens" label.
- Only the first round-trip per session is measured (once-per-session
  phases); later turns drift as the prompt cache and context grow.
- Usage numbers are provider-reported: absent/cache-read/reasoning
  fields vary by provider; the record tolerates missing buckets.

## 11. Revision history

- **v0.2** — baseline payload/usage audits, console + cards, handshake.
- **v0.2.1** — usage comprehensive accounting (full input, cache split,
  measured chars), payload share column, `lib/format.ts` extraction with
  the alignment machinery.
- **Session 2** — teaser/unfurl card renderer, terminology locked (share,
  handshake msg, `~` rule, full Input), six-section observation table.
- **This revision** — cold phase and Δ vs COLD removed (payload contains
  them), reason code shown on the card in both states, `/ppa` re-runs a
  payload audit, README split from this technical reference, handoff
  superseded.