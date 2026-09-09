# pi-prompt-analysis (ppa)

Cold-start prompt audit for [pi](https://github.com/earendil-works/pi-coding-agent).

Brand-new, "trivial" sessions carry hidden token weight — verbose tool
schemas, auto-discovery workspace dumps, heavy system prompts — before a
single user message is sent. **ppa measures that baseline** so you can keep
it lean, protect your prompt-cache prefix, and preserve breathing room
before provider limits.

At a glance:

- 🔍 **Two audits per session, automatically** — no setup, nothing sticky
- 🖥️ **Console blocks + inline transcript cards** per audit
- 🤝 **Optional warm-up handshake** on fresh UI sessions (default on, one turn)
- 🧩 **Structured records** for agents: `pi.events` `"ppa:audit"` + `/ppa json`
- 🛡️ **Passive**: hooks events, never modifies the LLM payload

## Install

```bash
pi install git:github.com/nirguk/pi-prompt-analysis
# pin a release
pi install git:github.com/nirguk/pi-prompt-analysis@v0.2.1
```

Or load once without installing:

```bash
pi -e git:github.com/nirguk/pi-prompt-analysis
```

## What it does

The audit runs automatically on every session; each phase logs a console
block, persists a `ppa:audit` session entry (never sent to the LLM), renders
an inline transcript card, and emits `"ppa:audit"` on `pi.events`.

| Phase | When | Captures |
|-------|------|----------|
| `payload` | first `before_agent_start` | Full pre-LLM payload breakdown: system prompt by source (custom prompt, tool snippets, guidelines, appended prompt, context files, skills), per-tool schema sizes, session messages → **TOTAL BASELINE**. The session-start reason code (`startup`/`new`/`resume`/`fork`/`reload`) is stamped on the record and shown on its card |
| `usage` | first `turn_end` with provider usage | Real provider token numbers from the first round-trip — **full input** (cache-read + fresh) and how much of it the measured payload accounts for |

Each phase reports **once per session**. Re-run a payload audit anytime with
`/ppa` (stamped `reason: "manual"`). On the `usage` phase only, a one-line
notification flashes with the captured baseline.

## What you'll see

**Console** — the payload block (cards show the same rows, without the raw
usage JSON):

```text
🔍 [PPA: payload] (2025-01-07T10:00:00.000Z)
  reason:       startup
  session:      /path/to/session.jsonl
  -----------------------------------------
  System Prompt:       15.7 K-chars   ~3.9 K-tokens  26%
     · context files:   6.6 K-chars   ~1.7 K-tokens  11%
     · guidelines:      4.0 K-chars   ~1.0 K-tokens   7%
     · skills:          3.1 K-chars   ~0.8 K-tokens   5%
  Tools (19):          43.7 K-chars  ~10.9 K-tokens  74%
     · subagent:       19.2 K-chars   ~4.8 K-tokens  32%
  Messages (0):         0.0 K-chars   ~0.0 K-tokens
  TOTAL BASELINE:      59.4 K-chars  ~14.9 K-tokens
```

**Console** — the usage block (real provider numbers):

```text
🔍 [PPA: usage] (2025-01-07T10:00:00.000Z)
  session:      /path/to/session.jsonl
  Input:         59.5 K-chars   15.5 K-tokens       → 99% cache-read
     · Payload:  59.4 K-chars  ~14.9 K-tokens  ≈ 96% of input tokens
     · handshake msg:  0.1 K-chars
  Output:         1.7 K-chars    0.1 K-tokens
  Cost:            $0.0005
  Billing:         cache-read 15.4 K-tokens · fresh 0.2 K-tokens · reasoning 0.1 K-tokens
  Usage: { "input":187, "output":128, "cacheRead":15360, ... }
```

`Payload` nests under `Input` (it dominates the input text — payload +
handshake message = input); `Output` is a peer row. The `· handshake msg:`
row is the non-payload input text (the automatic `handshake hello` turn; on
non-handshaked sessions it's labelled `· user msg:`).

### Cards & collapse/expand

Every audit is one inline transcript card. **Collapse/expand is
platform-owned**: click a card, or press `ctrl+o` (`app.tools.expand`,
rebindable in `~/.pi/agent/keybindings.json`).

- **Collapsed payload card** — a teaser: `reason:` line, `TOTAL:` row, top
  tool + top section with shares, `· N tools · N sections ▾`:

  ```
  🔍 PPA PAYLOAD
    reason:  startup
  TOTAL:           59.4 K-chars  ~14.9 K-tokens      ▾
  · subagent       19.2 K-chars   ~4.8 K-tokens  32%
  · context files   6.6 K-chars   ~1.7 K-tokens  11%
  · 19 tools · 6 sections ▾
  ```

- **Expanded payload card** — a full unfurl: headline total, every
  section/tool/message row with its share, plus a dimmed short time on the
  header (`🔍 PPA PAYLOAD  12:43:20`). Length caps (30 tools / 15 messages)
  exist only as safety valves for pathological sessions.
- **Usage card** — always-full in both states (no detail gating), `Input:`
  as the bold anchor, billing always visible.

## Commands

```text
/ppa         re-run the payload audit on current session state (reason: manual, logged + persisted)
/ppa json    dump the latest audit record as JSON (delivered as a notification)
```

## The handshake (default-on, UI sessions only)

On **genuinely fresh sessions with UI** (`reason: "startup" | "new"` — never
`resume`/`fork`/`reload` — and `ctx.hasUI`, true in TUI **and** RPC modes),
the extension fires one automatic warm-up turn by default:

```text
handshake hello
```

This warms the prompt-cache prefix and completes both phases before you type
anything. Print/JSON modes have no UI, so it's skipped there (the audit still
runs off your first real prompt).

Don't want the recurring warm-up cost?

```bash
pi --ppa-no-handshake
# or
PPA_HANDSHAKE=0 pi    # any value other than "0" leaves it enabled
```

## Understanding the numbers

- **Chars, not tokens, are measured** — every size is `JSON.stringify(...).length`.
- **`~` marks estimates** (`chars ÷ 4`, a planning heuristic). The `usage`
  phase reports **real provider tokens** — no `~`.
- **`Input` is the full input** (`fresh + cache-read`) — providers report
  `input` as the non-cached tokens only.
- **Share column** — each row's `%` of the payload total (e.g. `subagent 32%`).
- Tokenizer reality: a typical payload is ≈100% of input *chars* but ≈96% of
  input *tokens* (the real tokenizer runs ~3.8 chars/token).

The full glossary (all agreed terms, definitions, and design rationale) is in
[PPA_TECHNICAL.md](PPA_TECHNICAL.md#7-glossary-terminology-as-agreed).

## For agents & extension consumers

Subscribe to the audit records programmatically:

```ts
pi.events.on("ppa:audit", (record) => {
  // record is the full AuditRecord below
});
```

`/ppa json` returns the same object (latest record + count). The persisted
session entry is `type: "custom"`, `customType: "ppa:audit"`, `data` = the
record — usable from `ctx.sessionManager.getEntries()`.

| Field | Phase | Meaning |
|---|---|---|
| `phase` | both | `"payload"` \| `"usage"` |
| `at` | both | ISO timestamp of the audit |
| `reason` | payload | session-start code (`startup`/`new`/`resume`/`fork`/`reload`), or `"manual"` for `/ppa` |
| `sessionFile` | both | session path (when available) |
| `systemChars` | payload | measured chars of the built system prompt |
| `systemSections` | payload | `{ label, chars }[]` — the six system-prompt sections |
| `tools` | payload | `{ name, chars }[]` — per-tool schema sizes, largest first |
| `messageCount` / `messages` | payload | count + per-message `{ index, role, chars }` |
| `totalChars` | payload | system + tools + messages → `TOTAL BASELINE` |
| `payloadChars` | usage | measured chars of the payload text |
| `inputChars` | usage | measured chars of the full input text |
| `outputChars` | usage | measured chars of the assistant message |
| `payloadEstTokens` | usage | payload chars ÷ 4 (estimate) |
| `payloadSharePct` | usage | payload estimate as % of real input tokens |
| `handshakeSent` | usage | input warmed by the automatic handshake turn? |
| `usage` | usage | raw provider usage as-reported (`input`, `output`, `cacheRead`, `cacheWrite`, `reasoning`, `totalTokens`, `cost`) |

Design notes for consumers: records are **passive** (only measured; never
modify the payload), each phase fires **once per session**, and a warm
prompt-cache prefix means a handshaked first round-trip shows a high
cache-read share — that's the intended signal.

## The six system-prompt sections

The `payload` phase splits the system prompt into the same six sections the
agent itself builds. ppa records only each section's **size** — never its
text (passive). To see the content, use the sources below.

| Section | What it is | Where it comes from |
|---|---|---|
| `custom prompt` | Replaces the whole default system prompt | CLI `--system-prompt <text>`; auto-discovered `.pi/SYSTEM.md` (project, when trusted) or `~/.pi/agent/SYSTEM.md`; extension `systemPromptOverride` |
| `tool snippets` | One-line `- name: <snippet>` per enabled tool | Each active tool's registered snippet (`registerTool`) |
| `guidelines` | Extra guideline bullets in the default `Guidelines:` section | Tool definitions' `promptGuidelines` + session instructions |
| `appended prompt` | Verbatim text appended after the system prompt | CLI `--append-system-prompt <text>`; auto-discovered `.pi/APPEND_SYSTEM.md` / `~/.pi/agent/APPEND_SYSTEM.md` |
| `context files` | Pre-loaded file contents (`{path, content}`), rendered as `Context files:` | The AGENTS/CLAUDE chain: `AGENTS.override.md`, `AGENTS.md`, `CLAUDE.md` — global `~/.pi/agent/AGENTS.md` up through ancestor project dirs |
| `skills` | Pre-loaded skills (name, description, `SKILL.md` instructions) | Skill dirs `~/.pi/agent/skills`, `.pi/skills`, installed packages |

The whole built prompt: `event.systemPrompt` at `before_agent_start` (also in
the session file's pre-LLM payload entry). Programmatically:
`ctx.getSystemPromptOptions()` in a command handler.

## Notes

- All sizes use a **fixed K-scale** (÷1000, one decimal place, thousands
  separators, zero → `0.0`) — never re-scaled per row.
- The audit is **passive** except for the default-on handshake (disable via
  `--ppa-no-handshake` / `PPA_HANDSHAKE=0`).
- Tool size = `JSON.stringify({ description, parameters })`; message size =
  `JSON.stringify()` of the full message object.
- Every console row and expanded card carries the **share column**;
  `TOTAL BASELINE` is the payload total in chars.

## Technical reference

Architecture, the exact record model, measurement methodology, rendering
rules, the full terminology glossary, design decisions, and how to verify
changes (including `npm run typecheck`, the scripts, and the harness): see
**[PPA_TECHNICAL.md](PPA_TECHNICAL.md)**.

## License

MIT © nirguk