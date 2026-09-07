import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/*
 * pi-prompt-analysis (ppa)
 *
 * Problem: brand-new, "trivial" sessions carry hidden token weight —
 * verbose tool schemas, auto-discovery workspace dumps, or heavy system
 * prompts — before a single user message is sent.
 *
 * This extension audits the baseline:
 *   1. "cold"    - at session_start: serialized tool definitions + session messages
 *   2. "payload" - at the first before_agent_start: full pre-LLM payload breakdown
 *                   (system prompt sections, tool schemas, messages);
 *   3. "usage"   - at the first turn_end: real provider token usage from the first
 *                   LLM round-trip.
 *
 * Every audit is logged to console (pretty block), persisted in the session via
 * appendEntry ("ppa:audit"), and emitted on pi.events ("ppa:audit") so other
 * extensions can react.

 * Optional: --ppa-handshake forces a minimal first turn ("handshake hello")
 * on genuinely fresh sessions (reason: "startup" | "new") so the cold-start
 * baseline is measured automatically, the prompt-cache prefix is warmed, and
 * real work turns start from a known lean state.

 * Commands:
 *   /ppa          re-run the cold-start audit on current session state
 *   /ppa json     dump the latest audit record as JSON
 */

const CHARS_PER_TOKEN = 4; // rough estimate: chars / 4 ≈ tokens
const AUDIT_ENTRY = "ppa:audit";
const HANDSHAKE_FLAG = "ppa-handshake";
const HANDSHAKE_MESSAGE = "handshake hello";

type AuditPhase = "cold" | "payload" | "usage";

interface AuditSection {
  label: string;
  chars: number;
}

interface AuditMessage {
  index: number;
  role: string;
  chars: number;
}

interface AuditTool {
  name: string;
  chars: number;
}

interface AuditRecord {
  phase: AuditPhase;
  at: string;
  reason?: string;
  sessionFile?: string;
  systemChars?: number;
  systemSections?: AuditSection[];
  tools?: AuditTool[];
  messageCount: number;
  messages?: AuditMessage[];
  totalChars?: number;
  usage?: Record<string, unknown>;
}

function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** JSON-stringify a value, falling back to String() on circular refs etc. */
function serialize(value: unknown): string {
  try {
    const s = JSON.stringify(value);
    return s ?? "";
  } catch {
    return String(value ?? "");
  }
}

function recordMessages(messages: Array<Record<string, any>>): AuditMessage[] {
  return (messages ?? []).map((m, i) => ({
    index: i,
    role: String(m.role ?? m.customType ?? "?"),
    chars: serialize(m).length,
  }));
}

function toolMetas(pi: ExtensionAPI): AuditTool[] {
  return pi
    .getAllTools()
    .map((t) => ({
      name: t.name,
      chars: serialize({ description: t.description, parameters: t.parameters }).length,
    }))
    .sort((a, b) => b.chars - a.chars);
}

function sessionMessages(ctx: { sessionManager: { buildContextEntries?(): unknown[] } }): Array<Record<string, any>> {
  try {
    const entries = ctx.sessionManager.buildContextEntries?.() ?? [];
    return entries
      .filter((e: any) => e.type === "message")
      .map((e: any) => e.message as Record<string, any>);
  } catch {
    return [];
  }
}

function emit(pi: ExtensionAPI, record: AuditRecord): void {
  const out: string[] = [];
  out.push(`🔍 [PPA: ${record.phase}] (${record.at})`);
  if (record.reason) out.push(`  reason:       ${record.reason}`);
  if (record.sessionFile) out.push(`  session:       ${record.sessionFile}`);
  if (record.systemChars) {
    out.push(`  System Prompt: ~${estimateTokens(record.systemChars)} tok (${record.systemChars} ch)`);
    for (const s of record.systemSections ?? []) {
      out.push(`      · ${s.label}: ${s.chars} ch (~${estimateTokens(s.chars)} tok)`);
    }
  }
  if (record.tools && record.tools.length > 0) {
    const toolsChars = record.tools.reduce((n, t) => n + t.chars, 0);
    out.push(`  Tools (${record.tools.length}): ${toolsChars} ch (~${estimateTokens(toolsChars)} tok)`);
    for (const t of record.tools) {
      out.push(`      · ${t.name}: ${t.chars} ch`);
    }
  }
  if (record.messages) {
    const messagesChars = record.messages.reduce((n, m) => n + m.chars, 0);
    out.push(`  Messages (${record.messageCount}): ${messagesChars} ch (~${estimateTokens(messagesChars)} tok)`);
    for (const m of record.messages) {
      out.push(`      · [${m.index}] (${m.role}): ${m.chars} ch (~${estimateTokens(m.chars)} tok)`);
    }
  }
  if (record.usage) {
    out.push(`  Usage: ${serialize(record.usage)}`);
  }
  if (record.totalChars) {
    out.push("  -----------------------------------------");
    out.push(`  TOTAL BASELINE: ~${estimateTokens(record.totalChars)} tokens (${record.totalChars} chars)`);
  }
  console.log(out.join("\n"));

// Persist in session (TUI-only, not sent to LLM); surface for other extensions
  pi.appendEntry(AUDIT_ENTRY, { ...record });
  pi.events.emit("ppa:audit", record);
}

export default function (pi: ExtensionAPI) {
  pi.registerFlag(HANDSHAKE_FLAG, {
    description:
      "PPA: force a minimal first turn ('handshake hello') on fresh sessions to warm the prompt cache and establish a measured baseline",
    type: "boolean" as const,
    default: false,
  });

  let handshakeQueued = false;

  // ── Phase 0: cold-start baseline (session init, before any user message)
  pi.on("session_start", async (event, ctx) => {
    const reason = event.reason;
    const messages = sessionMessages(ctx);
    const tools = toolMetas(pi);
    const toolsChars = tools.reduce((n, t) => n + t.chars, 0);
    const messagesChars = messages.reduce((n, m) => n + serialize(m).length, 0);

    emit(pi, {
      phase: "cold",
      at: new Date().toISOString(),
      reason,
      sessionFile: ctx.sessionManager.getSessionFile() ?? undefined,
      tools,
      messageCount: messages.length,
      messages: recordMessages(messages),
      totalChars: toolsChars + messagesChars,
    });

    // Handshake: one minimal first turn on genuinely fresh sessions only。
    if (
      !handshakeQueued &&
      pi.getFlag(HANDSHAKE_FLAG) &&
      (reason === "startup" || reason === "new")
    ) {
      handshakeQueued = true;
      try {
        ctx.ui.notify(`PPA: handshake → "${HANDSHAKE_MESSAGE}"`, "info");
        pi.sendUserMessage(HANDSHAKE_MESSAGE);
      } catch (err) {
        console.warn(`[ppa] handshake could not be sent: ${(err as Error).message ?? err}`);
      }
    }
  });

  // ── Phase 1: full pre-LLM payload breakdown (first turn only)
  let payloadLogged = false;
  pi.on("before_agent_start", (event, ctx) => {
    if (payloadLogged) return;
    payloadLogged = true;

    const o = event.systemPromptOptions ?? {};
    const rawSections: Array<[string, unknown]> = [
      ["custom prompt", o.customPrompt ?? ""],
      ["tool snippets", o.toolSnippets ?? []],
      ["guidelines", o.promptGuidelines ?? []],
      ["appended prompt", o.appendSystemPrompt ?? ""],
      ["context files", o.contextFiles ?? []],
      ["skills", o.skills ?? []],
    ];
    const sections: AuditSection[] = rawSections.map(([label, text]) => ({
      label,
      chars: serialize(text).length,
    }));

    const tools = toolMetas(pi);
    const messages = sessionMessages(ctx);
    const toolsChars = tools.reduce((n, t) => n + t.chars, 0);
    const messagesChars = messages.reduce((n, m) => n + serialize(m).length, 0);
    const systemChars = event.systemPrompt?.length ?? 0;

    emit(pi, {
      phase: "payload",
      at: new Date().toISOString(),
      sessionFile: ctx.sessionManager.getSessionFile() ?? undefined,
      systemChars,
      systemSections: sections,
      tools,
      messageCount: messages.length,
      messages: recordMessages(messages),
      totalChars: systemChars + toolsChars + messagesChars,
    });
  });

  // ── Phase 2: first-turn real usage (provider token accounting)
  let usageLogged = false;
  pi.on("turn_end", (event, _ctx) => {
    if (usageLogged) return;
    const usage = (event.message as any)?.usage;
    if (!usage) return;
    usageLogged = true;

    const record: AuditRecord = {
      phase: "usage",
      at: new Date().toISOString(),
      usage: usage as Record<string, unknown>,
      messageCount: 0,
    };
    emit(pi, record);
  });

  // ── /ppa command: re-run audit on demand, or dump latest as JSON
  pi.registerCommand("ppa", {
    description: "PPA: re-run the cold-start prompt audit on the current session state",
    getArgumentCompletions: (prefix: string) =>
      ["audit", "json"]
        .filter((a) => a.startsWith(prefix))
        .map((a) => ({ value: a, label: a })),
    handler: async (args: string, ctx) => {
      const entries = ctx.sessionManager
        .getEntries()
        .filter((e: any) => e.type === "custom" && e.customType === AUDIT_ENTRY) as Array<Record<string, any>>;

      if (args === "json") {
        const last = entries[entries.length - 1];
        ctx.ui.notify(
          last
            ? JSON.stringify({ latest: last.data, count: entries.length }, null, 2)
            : `No PPA audits yet in this session (found ${entries.length})`,
          "info",
        );
        return;
      }

      const messages = sessionMessages(ctx);
      const tools = toolMetas(pi);
      const toolsChars = tools.reduce((n, t) => n + t.chars, 0);
      const messagesChars = messages.reduce((n, m) => n + serialize(m).length, 0);

      emit(pi, {
        phase: "cold",
        at: new Date().toISOString(),
        reason: "manual",
        sessionFile: ctx.sessionManager.getSessionFile() ?? undefined,
        tools,
        messageCount: messages.length,
        messages: recordMessages(messages),
        totalChars: toolsChars + messagesChars,
      });
      ctx.ui.notify(
        `PPA audit logged (${entries.length + 1} total in this session; see console or /session)`,
        "info",
      );
    },
  });
}