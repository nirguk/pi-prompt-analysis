# pi-prompt-analysis (ppa)

Cold-start prompt audit for [pi](https://github.com/earendil-works/pi-coding-agent). Brand-new, "trivial" sessions often carry hidden token weight — verbose tool schemas, auto-discovery workspace dumps, or heavy system prompts — before a single user message is sent. This package measures that baseline so you can keep it lean, protect your prompt-cache prefix, and preserve breathing room before provider limits.

## What it does

Every audit phase is logged to the console, persisted in the session (`ppa:audit` custom entries), rendered as a compact inline card in the TUI transcript, and emitted on `pi.events` (`"ppa:audit"` for inter-extension consumers). The `usage` phase also flashes a transient one-line notify with the captured baseline — nothing is sticky, no widget/status/overlay.

| Phase | When | Captures |
|-------|------|----------|
| `cold` | `session_start` | Serialized tool definitions (per-tool sizes, top offenders first) + session messages (usually empty on fresh) |
| `payload` | first `before_agent_start` | Full pre-LLM payload breakdown: system prompt (by source: custom prompt, tool snippets, guidelines, appended prompt, context files, skills), tool schemas, messages → TOTAL BASELINE |
| `usage` | first `turn_end` | Real provider token usage from the first LLM round-trip |

## Install

```bash
pi install git:github.com/nirguk/pi-prompt-analysis
# pin once stable
pi install git:github.com/nirguk/pi-prompt-analysis@v0.1.0
```

Or load once without installing:

```bash
pi -e git:github.com/nirguk/pi-prompt-analysis
```

## Usage

No setup needed — the audit runs automatically on every session (console blocks + `ppa:audit` entries + TUI card + one-line notify on the usage phase; latest numbers via `/ppa json`).

On **genuinely fresh interactive sessions only** (`startup` / `new` — never `resume` / `fork`, and never in print/RPC modes where there is no UI), the extension also fires one automatic warm-up turn by default:

```text
handshake hello
```

…which warms the prompt-cache prefix and completes the audit through all three phases before you type anything.

If you don't want that recurring warm-up cost, disable it:

```bash
pi --ppa-no-handshake
# or
PPA_HANDSHAKE=0 pi
```

### Commands

```text
/ppa          re-run the cold-start audit on current session state (logged + persisted)
/ppa json    dump the latest audit record as JSON
```

## Output shape (console)

```text
🔍 [PPA: cold] (2025-01-07T10:00:00.000Z)
  reason:       startup
  session:       /path/to/session.jsonl
  Tools (42): 26274 ch (~6569 tok)
      · bash: 9241 ch
      · read:  8103 ch
      · ...
  Messages (0): 0 ch (~0 tok)
  -----------------------------------------
  TOTAL BASELINE: ~6569 tokens (26274 chars)
```

## Notes

- Token estimate: `chars / 4` — a rough heuristic for planning, not a billing meter. The `usage` phase reports the real provider numbers.
- The audit is bang-for-buck passive: it hooks events and never modifies the payload or session.
- All tool/message sizes are measured on `JSON.stringify()` of the actual objects that go toward the LLM payload.

## License

MIT © nirguk