import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

/*
 * pi-prompt-analysis (ppa)
 *
 * Problem: brand-new, "trivial" sessions carry hidden token weight —
 * verbose tool schemas, auto-discovery workspace dumps, or heavy system
 * prompts — before a single user message is sent.
 *
 * This extension audits the baseline:
 *    1. "cold"    - at session_start: serialized tool definitions + session messages
 *    2. "payload" - at the first before_agent_start: full pre-LLM payload breakdown
 *                   (system prompt sections, tool schemas, messages)
 *    3. "usage"   - at the first turn_end: real provider token usage from the first
 *                   LLM round-trip.
 *
 * Every audit is logged to console (pretty block), persisted in the session via
 * appendEntry ("ppa:audit"), rendered as an inline transcript card in the TUI, and
 * emitted on pi.events ("ppa:audit") so other extensions can react.
 *
 * Handshake: enabled by default on genuinely fresh interactive sessions
 * (reason: "startup" | "new" — never resume/fork — and ctx.hasUI): the extension
 * fires one minimal first turn ("handshake hello") to warm the prompt-cache prefix
 * and complete the audit through all three phases before you type anything.
 * Disable with --ppa-no-handshake or env PPA_HANDSHAKE=0. (Print/json modes
 * have no UI (ctx.hasUI=false), so there the handshake is skipped by design.)
 *
 * Commands:
 *    /ppa         re-run the cold-start audit on current session state
 *    /ppa json    dump the latest audit record as JSON
 */

const CHARS_PER_TOKEN = 4; // rough estimate: chars / 4 ≈ tokens
const AUDIT_ENTRY = "ppa:audit";
const NO_HANDSHAKE_FLAG = "ppa-no-handshake";
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

/** Human-friendly byte count: 15332 → "15.0KB", 900 → "900B". */
function fmtBytes(chars: number): string {
  const n = Number(chars ?? 0);
  if (!Number.isFinite(n) || n <= 0) return "0B";
  if (n >= 1024) return `${(n / 1024).toFixed(1).replace(/\.0$/, "")}KB`;
  return `${Math.round(n)}B`;
}

/** Human-friendly token count: 15556 → "15.6k", 812 → "812". */
function fmtTokens(n: number): string {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v) || v <= 0) return "0";
  if (v >= 1000) return `${(v / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${Math.round(v)}`;
}

/** Dollar figure: 0.00218344 → "0.0022", 1.5 → "1.5". */
function fmtCost(n: number | undefined): string | undefined {
  if (typeof n !== "number" || !Number.isFinite(n)) return undefined;
  return `$${n.toFixed(n < 0.01 ? 4 : 2).replace(/\.?0+$/, "")}`;
}

/** Extract normalized usage numbers pi reports. */
function usageNumbers(usage: unknown): { input?: number; output?: number; cost?: number } {
  const u = (usage ?? {}) as Record<string, any>;
  const num = (v: unknown): number | undefined => {
    if (typeof v === "number") return v;
    if (typeof v === "string" && v.trim() !== "") return Number(v);
    return undefined;
  };
  const cost = u.cost as Record<string, any> | undefined;
  return {
    input: num(u.input ?? u.input_tokens),
    output: num(u.output ?? u.output_tokens),
    cost: cost ? num(cost.total ?? cost.total_cost) : num(u.cost_usd),
  };
}

function emit(pi: ExtensionAPI, record: AuditRecord): void {
  const out: string[] = [];
  out.push(`🔍 [PPA: ${record.phase}] (${record.at})`);
  if (record.reason) out.push(`  reason:        ${record.reason}`);
  if (record.sessionFile) out.push(`  session:       ${record.sessionFile}`);
  if (record.systemChars) {
    out.push(`  System Prompt: ~${estimateTokens(record.systemChars)} tok (${record.systemChars} ch)`);
    for (const s of record.systemSections ?? []) {
      out.push(`     · ${s.label}: ${s.chars} ch (~${estimateTokens(s.chars)} tok)`);
    }
  }
  if (record.tools && record.tools.length > 0) {
    const toolsChars = record.tools.reduce((n, t) => n + t.chars, 0);
    out.push(`  Tools (${record.tools.length}): ${toolsChars} ch (~${estimateTokens(toolsChars)} tok)`);
    for (const t of record.tools) {
      out.push(`     · ${t.name}: ${t.chars} ch`);
    }
  }
  if (record.messages) {
    const messagesChars = record.messages.reduce((n, m) => n + m.chars, 0);
    out.push(`  Messages (${record.messageCount}): ${messagesChars} ch (~${estimateTokens(messagesChars)} tok)`);
    for (const m of record.messages) {
      out.push(`     · [${m.index}] (${m.role}): ${m.chars} ch (~${estimateTokens(m.chars)} tok)`);
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

  pi.appendEntry(AUDIT_ENTRY, { ...record });
  pi.events.emit("ppa:audit", record);
}

/** Inline transcript card (TUI-only). */
function renderAuditCard(entry: { data?: AuditRecord }, expanded: boolean, theme: any): any {
  const rec = entry.data ?? ({} as AuditRecord);
  const dim = (s: string) => theme.fg("dim", s);
  const muted = (s: string) => theme.fg("muted", s);
  const accent = (s: string) => theme.fg("accent", s);
  const big = (s: string) => theme.fg("accent", theme.bold(s));
  const clamp = (s: string, max: number) => (s.length > max ? s.slice(0, max - 3) + "..." : s);

  const lines: string[] = [];
  const phase = String(rec.phase ?? "?").toUpperCase();
  const at = (rec.at ?? "").replace("T", " ").slice(0, 19);
  lines.push(`${accent("🔍 PPA " + phase)}${at ? muted(`  ${at}`) : ""}`);

  if (rec.usage) {
    const us = usageNumbers(rec.usage);
    if (typeof us.input === "number") {
      lines.push(`${big(`~${fmtTokens(us.input)} input tok`)}${muted(` (${fmtBytes(us.input * CHARS_PER_TOKEN)})`)}${us.cost ? muted(`  ≈${fmtCost(us.cost) ?? ""}`) : ""}`);
    }
    if (typeof us.output === "number") lines.push(`${muted("  Output:")} ${fmtTokens(us.output)} tok`);
    if (typeof us.cost === "number") lines.push(`${muted("  Cost:")}  ${fmtCost(us.cost) ?? "—"}`);
    lines.push(dim("  (full detail on console)"));
  } else {
    const totalChars = Number(rec.totalChars ?? 0);
    const totalTok = estimateTokens(totalChars);
    if (totalChars > 0) {
      lines.push(`${big(`~${fmtTokens(totalTok)} tok`)}${muted(` (${fmtBytes(totalChars)})`)}`);
    }
    if (rec.systemChars) {
      lines.push(`${muted("  System prompt:")} ${fmtBytes(rec.systemChars)} (~${fmtTokens(estimateTokens(rec.systemChars))} tok)`);
      if (expanded) {
        for (const s of (rec.systemSections ?? []).slice(0, 6)) {
          lines.push(dim(`     · ${clamp(s.label, 28)}: ${fmtBytes(s.chars)}`));
        }
      }
    }
    const tools = rec.tools ?? [];
    const toolsChars = tools.reduce((n, t) => n + t.chars, 0);
    const showTools = expanded ? tools.slice(0, 30) : tools.slice(0, 3);
    if (tools.length > 0) {
      lines.push(`${muted(`  Tools (${tools.length}):`)} ${fmtBytes(toolsChars)} (~${fmtTokens(estimateTokens(toolsChars))} tok)`);
      for (const t of showTools) {
        lines.push(dim(`     · ${clamp(t.name, 30)}: ${fmtBytes(t.chars)}`));
      }
      if (!expanded && tools.length > showTools.length) {
        lines.push(dim(`     · ${clamp(tools[showTools.length].name, 30)}: ${fmtBytes(tools[showTools.length].chars)}…`));
      }
    }
    const messages = rec.messages ?? [];
    const messagesChars = messages.reduce((n, m) => n + m.chars, 0);
    const showMessages = expanded ? messages.slice(0, 15) : [];
    if (messages.length > 0 || expanded) {
      lines.push(`${muted(`  Messages (${messages.length}):`)} ${fmtBytes(messagesChars)} (~${fmtTokens(estimateTokens(messagesChars))} tok)`);
      for (const m of showMessages) {
        lines.push(dim(`     · [${m.index}] (${m.role}): ${fmtBytes(m.chars)} (~${fmtTokens(estimateTokens(m.chars)} tok)`));
      }
      if (expanded && messages.length > showMessages.length) {
        lines.push(dim(`     · … ${messages.length - showMessages.length} more`));
      }
    }
    if (!expanded) lines.push(dim("  · Expand for the full breakdown."));
  }

  const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
  box.addChild(new Text(lines.join("\n"), 0, 0));
  return box;
}

export default function (pi: ExtensionAPI) {
  pi.registerFlag(NO_HANDSHAKE_FLAG, {
    description:
      "PPA: disable the automatic one-turn 'handshake hello' warm-up (enabled by default on fresh interactive sessions; env PPA_HANDSHAKE=0 also disables)",
    type: "boolean" as const,
    default: false,
  });

  pi.registerEntryRenderer<AuditRecord>(AUDIT_ENTRY, (entry, { expanded }, theme) => renderAuditCard(entry, expanded, theme));

  let handshakeQueued = false;

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

    if (
      !handshakeQueued &&
      !pi.getFlag(NO_HANDSHAKE_FLAG) &&
      process.env.PPA_HANDSHAKE !== "0" &&
      ctx.hasUI &&
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

  let usageLogged = false;
  pi.on("turn_end", (event, ctx) => {
    if (usageLogged) return;
    const usage = (event.message as any)?.usage;
    if (!usage) return;
    usageLogged = true;

    const record: AuditRecord = {
      phase: "usage",
      at: new Date().toISOString(),
      sessionFile: ctx.sessionManager.getSessionFile() ?? undefined,
      usage: usage as Record<string, unknown>,
      messageCount: 0,
    };
    emit(pi, record);

    if (ctx.hasUI) {
      const us = usageNumbers(usage);
      const parts: string[] = [];
      if (typeof us.input === "number") parts.push(`~${fmtTokens(us.input)} tok (${fmtBytes(us.input * CHARS_PER_TOKEN)})`);
      if (typeof us.cost === "number") parts.push(`≈${fmtCost(us.cost) ?? ""}`);
      ctx.ui.notify(
        `PPA baseline captured: ${parts.join(" ") || "first turn"} — card in transcript, full detail on console`,
        "info",
      );
    }
  });

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
