# pi-prompt-analysis (ppa)

Cold-start prompt audit for [pi](https://github.com/earendil-works/pi-coding-agent). Brand-new, "trivial" sessions carry hidden token weight — verbose tool schemas, auto-discovery workspace dumps, heavy system prompts — before a single user message is sent. This package measures that baseline so you can keep it lean, protect your prompt-cache prefix, and preserve breathing room before provider limits.

## What it does

The extension hooks three session events; for each, it logs an audit block to the console, persists it in the session (`ppa:audit` custom entries — never sent to the LLM), renders it as an inline card in the TUI transcript, and emits it on `pi.events` (`"ppa:audit"`) for inter-extension consumers. On the `usage` phase only, it also flashes a one-line transient notification with the captured baseline. Nothing is sticky — no widget, status line, or overlay.

| Phase | When | Captures |
|-------|------|----------|
| `cold` | every `session_start` (reason recorded: `startup`/`new`/`resume`/`fork`/`reload`) | Per-tool serialized schema size (`JSON.stringify({ description, parameters })`), top offenders first, + session messages (usually empty on fresh) |
| `payload` | first `before_agent_start` | Full pre-LLM payload breakdown: system prompt by source (custom prompt, tool snippets, guidelines, appended prompt, context files, skills), tool schemas, messages → TOTAL BASELINE |
| `usage` | first `turn_end` whose assistant message carries provider usage | Real provider token usage (input/output/cost) from the first LLM round-trip |

`payload` and `usage` each report once per session. `cold` reports at every session start and can be re-run any time with `/ppa`.

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

## Usage

No setup needed — the audit runs automatically on every session: console blocks, `ppa:audit` session entries, TUI transcript cards, and (for the `usage` phase) a one-line notify. Get the latest record as JSON with `/ppa json`.

### Handshake (default-on, UI sessions only)

On **genuinely fresh sessions with UI** (`reason: "startup" | "new"` — never `resume`/`fork`/`reload` — and `ctx.hasUI`, which is true in TUI **and RPC** modes), the extension fires one automatic warm-up turn by default to warm the prompt-cache prefix and complete the audit through all three phases before you type anything:

```text
handshake hello
```

In print/JSON modes there is no UI, so the handshake is skipped (the audit still runs off your first real prompt).

If you don't want the recurring warm-up cost:

```bash
pi --ppa-no-handshake
# or
PPA_HANDSHAKE=0 pi    # any value other than "0" leaves it enabled
```

### Commands

```text
/ppa         re-run the cold-start audit on current session state (logged + persisted)
/ppa json    dump the latest audit record as JSON (delivered as a notification)
```

## Output shape (console)

```text
🔍 [PPA: cold] (2025-01-07T10:00:00.000Z)
  reason:       startup
  session:       /path/to/session.jsonl
  Tools (18): 43313 ch (~10829 tok)
     · subagent: 19244 ch
     · web_search: 4584 ch
     · ...
  Messages (0): 0 ch (~0 tok)
  -----------------------------------------
  TOTAL BASELINE: ~10829 tokens (43313 chars)
```

(The `payload` phase additionally lists `System Prompt: ~N tok (N ch)` with per-source breakdowns and a higher total; the `usage` phase prints the real provider usage object.)

## Notes

- `cold`/`payload` token figures are estimates (`chars / 4` — a rough heuristic for planning, not a billing meter). The `usage` phase reports the real provider numbers.
- The audit itself is passive: it only hooks events and never modifies the LLM payload. The one exception is the default-on interaction handshake, which injects a single `handshake hello` user turn into fresh UI sessions (disable via `--ppa-no-handshake` / `PPA_HANDSHAKE=0`).
- Tool size = `JSON.stringify({ description, parameters })` of each tool; message size = `JSON.stringify()` of the full message object.

## License

MIT © nirguk