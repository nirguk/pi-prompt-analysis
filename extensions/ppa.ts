import type {
  ExtensionAPI,
  ExtensionContext,
  CustomEntry,
  EntryRenderer,
  SessionMessageEntry,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import {
  CHARS_PER_TOKEN,
  alignCells,
  estimateTokens,
  fmtKChars,
  fmtKTokens,
  fmtKTokensFromTokens,
  renderAlignedRows,
  type RowInput,
} from "./lib/format.ts";

/*
 * pi-prompt-analysis (ppa)
 *
 * Problem: brand-new, "trivial" sessions carry hidden token weight —
 * verbose tool schemas, auto-discovery workspace dumps, or heavy system
 * prompts — before a single user message is sent.
 *
 * This extension audits the baseline:
 *    1. "payload" - at the first before_agent_start: full pre-LLM payload breakdown
 *                   (system prompt sections, tool schemas, messages) — the cold-start
 *                   audit itself (a separate "cold" snapshot was dropped: the payload
 *                   fully contains it, so it added a duplicate block + a Δ row for no
 *                   new information)
 *    2. "usage"   - at the first turn_end: real provider token usage from the
 *                   first LLM round-trip — the FULL input accounting (cache-
 *                   read + fresh split) plus how much of it the measured
 *                   payload accounts for.
 *
 * Every audit is logged to console (pretty block), persisted in the session via
 * appendEntry ("ppa:audit"), rendered as an inline transcript card in the TUI, and
 * emitted on pi.events ("ppa:audit") so other extensions can react.
 *
 * Card collapse/expand is platform-owned (Q7): the transcript toggles custom
 * entry cards on click and on app.tools.expand (default ctrl+o), so this
 * renderer only branches on the injected `expanded` flag. Collapsed = teaser
 * (top offender + counts, no timestamp); expanded = full unfurl (every row
 * with its % share of the phase total). The session-start reason code
 * (`startup`/`new`/`resume`/`fork`/`reload`) is stamped on the payload record
 * and rendered as a line above the table in BOTH states — one shared code
 * path between teaser and expanded, no duplication.
 *
 * Terminology (match the README glossary): every numeric row carries an
 * optional right-aligned SHARE column (its % of that phase's total); usage
 * "Input" is the FULL input (fresh + cache-read, never provider "input"
 * alone); the `· handshake msg:` row is the non-payload input text (normally
 * the handshake user turn); a `~` prefix marks guesstimates (chars ÷ 4) —
 * real provider numbers never get it. See README "The six system-prompt
 * sections" for where each payload section comes from and how to observe it.
 *
 * Handshake: enabled by default on genuinely fresh sessions with UI
 * (reason: "startup" | "new" — never resume/fork/reload — and ctx.hasUI,
 * which is true in TUI and RPC modes): the extension fires one minimal first
 * turn ("handshake hello") to warm the prompt-cache prefix and complete the
 * audit through both phases (payload + usage) before you type anything. Disable with
 * --ppa-no-handshake or env PPA_HANDSHAKE=0. (Print/json modes have no UI
 * (ctx.hasUI=false), so there the handshake is skipped by design.)
 *
 * Commands:
 *    /ppa         re-run the payload audit on current session state (reason: manual)
 *    /ppa json    dump the latest audit record as JSON
 */

const AUDIT_ENTRY = "ppa:audit";
const NO_HANDSHAKE_FLAG = "ppa-no-handshake";
const HANDSHAKE_MESSAGE = "handshake hello";

type AuditPhase = "payload" | "usage";

/** Reason codes pi emits on `session_start` (see SessionStartEvent in pi's types). */
type SessionStartReason = "startup" | "reload" | "new" | "resume" | "fork";
/** Reason stamped on an audit record: a session-start code, or "manual" for `/ppa`. */
type AuditReason = SessionStartReason | "manual";

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
  /** session-start reason (startup/new/resume/fork/reload; "manual" for /ppa) — shown above the payload card table */
  reason?: AuditReason;
  sessionFile?: string;
  systemChars?: number;
  systemSections?: AuditSection[];
  tools?: AuditTool[];
  messageCount: number;
  messages?: AuditMessage[];
  totalChars?: number;
  /** usage phase: measured chars of the payload text (from the payload record) */
  payloadChars?: number;
  /** usage phase: measured chars of the full input text (payload + prior non-assistant messages) */
  inputChars?: number;
  /** usage phase: measured chars of the assistant message (output text) */
  outputChars?: number;
  /** usage phase: payload estimate in tokens (payloadChars ÷ 4) */
  payloadEstTokens?: number;
  /** usage phase: payload estimate as % of total first-turn input */
  payloadSharePct?: number;
  /** usage phase: whether the input was warmed by the automatic handshake turn */
  handshakeSent?: boolean;
  usage?: RawUsage;
}

/**
 * Loose shape for provider usage payloads. The native `Usage` type satisfies it
 * structurally; the extra optional fields tolerate alternate field names (e.g.
 * legacy `input_tokens` / `cost_usd`) without forcing an `as any` cast.
 */
interface RawUsage {
  input?: number | string;
  output?: number | string;
  input_tokens?: number | string;
  output_tokens?: number | string;
  cacheRead?: number | string;
  cacheWrite?: number | string;
  reasoning?: number | string;
  totalTokens?: number | string;
  cost?: { total?: number | string; total_cost?: number | string };
  cost_usd?: number | string;
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

function recordMessages(messages: readonly SessionMessageEntry["message"][]): AuditMessage[] {
  return messages.map((m, i) => ({
    index: i,
    role: String(m.role ?? "?"),
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

function sessionMessages(ctx: ExtensionContext): SessionMessageEntry["message"][] {
  try {
    const entries = ctx.sessionManager.buildContextEntries();
    return entries
      .filter((e): e is SessionMessageEntry => e.type === "message")
      .map((e) => e.message);
  } catch {
    return [];
  }
}

/** The six system-prompt sources, labelled and sized (payload + /ppa share this). */
interface SystemPromptLike {
  customPrompt?: unknown;
  toolSnippets?: unknown;
  promptGuidelines?: unknown;
  appendSystemPrompt?: unknown;
  contextFiles?: unknown;
  skills?: unknown;
}

function systemSections(o: SystemPromptLike): AuditSection[] {
  const rawSections: Array<[string, unknown]> = [
    ["custom prompt", o.customPrompt ?? ""],
    ["tool snippets", o.toolSnippets ?? []],
    ["guidelines", o.promptGuidelines ?? []],
    ["appended prompt", o.appendSystemPrompt ?? ""],
    ["context files", o.contextFiles ?? []],
    ["skills", o.skills ?? []],
  ];
  return rawSections.map(([label, text]) => ({
    label,
    chars: serialize(text).length,
  }));
}

/** One aligned row: label + K-chars + ~K-tokens guesstimate (fixed K-scale). */
function kRow(label: string, chars: number): RowInput {
  return { label, chars: fmtKChars(chars), tokens: `~${fmtKTokens(chars)}` };
}

/** Dollar figure: 0.00218344 → "0.0022", 1.5 → "1.5". */
function fmtCost(n: number | undefined): string | undefined {
  if (typeof n !== "number" || !Number.isFinite(n)) return undefined;
  return `$${n.toFixed(n < 0.01 ? 4 : 2).replace(/\.?0+$/, "")}`;
}

interface UsageNumbers {
  input?: number;
  output?: number;
  cost?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  totalTokens?: number;
}

/** Extract normalized usage numbers from a raw usage payload. */
function usageNumbers(usage: RawUsage): UsageNumbers {
  const num = (v: number | string | undefined): number | undefined => {
    if (typeof v === "number") return v;
    if (typeof v === "string" && v.trim() !== "") return Number(v);
    return undefined;
  };
  return {
    input: num(usage.input ?? usage.input_tokens),
    output: num(usage.output ?? usage.output_tokens),
    cost: num(usage.cost?.total ?? usage.cost?.total_cost ?? usage.cost_usd),
    cacheRead: num(usage.cacheRead),
    cacheWrite: num(usage.cacheWrite),
    reasoning: num(usage.reasoning),
    totalTokens: num(usage.totalTokens),
  };
}

/**
 * Total input tokens for a round-trip. Providers report `input` as the
 * NON-cached tokens only; the cached prefix arrives separately as
 * `cacheRead`. Summing them gives the whole pre-LLM stream actually sent.
 */
function totalInputTokens(us: UsageNumbers): number | undefined {
  if (typeof us.input !== "number") return undefined;
  if (typeof us.cacheRead === "number") return us.input + us.cacheRead;
  return us.input;
}

/** Latest audit record of a given phase in the current session. */
function findAudit(ctx: ExtensionContext, phase: AuditPhase): AuditRecord | undefined {
  try {
    const entries = ctx.sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e?.type !== "custom") continue;
      const entry = e as CustomEntry<AuditRecord>;
      if (entry.customType !== AUDIT_ENTRY) continue;
      const data = entry.data;
      if (data?.phase === phase) return data;
    }
  } catch {
    // session entries unavailable (e.g. headless) — treat as no prior audit
  }
  return undefined;
}

function emit(pi: ExtensionAPI, record: AuditRecord): void {
  const out: string[] = [];
  out.push(`🔍 [PPA: ${record.phase}] (${record.at})`);
  if (record.reason) out.push(`  reason:        ${record.reason}`);
  if (record.sessionFile) out.push(`  session:       ${record.sessionFile}`);
  const rows: RowInput[] = [];
  /** every row carries its % share of this phase's total */
  const shareFor = (chars: number): string | undefined => {
    if (typeof record.totalChars !== "number" || record.totalChars <= 0) return undefined;
    const pct = Math.round((chars / record.totalChars) * 100);
    return pct > 0 ? `${pct}%` : undefined;
  };
  if (record.systemChars) {
    rows.push({ ...kRow("  System Prompt:", record.systemChars), share: shareFor(record.systemChars) });
    for (const s of record.systemSections ?? []) {
      rows.push({ ...kRow(`     · ${s.label}:`, s.chars), share: shareFor(s.chars) });
    }
  }
  if (record.tools && record.tools.length > 0) {
    const toolsChars = record.tools.reduce((n, t) => n + t.chars, 0);
    rows.push({ ...kRow(`  Tools (${record.tools.length}):`, toolsChars), share: shareFor(toolsChars) });
    for (const t of record.tools) {
      rows.push({ ...kRow(`     · ${t.name}:`, t.chars), share: shareFor(t.chars) });
    }
  }
  if (record.messages) {
    const messagesChars = record.messages.reduce((n, m) => n + m.chars, 0);
    rows.push(kRow(`  Messages (${record.messageCount}):`, messagesChars));
    for (const m of record.messages) {
      rows.push(kRow(`     · [${m.index}] (${m.role}):`, m.chars));
    }
  }
  if (record.totalChars) {
    rows.push(kRow("  TOTAL BASELINE:", record.totalChars));
    out.push("  -----------------------------------------");
  }
  if (rows.length > 0) out.push(...renderAlignedRows(rows));
  if (record.usage) {
    const us = usageNumbers(record.usage);
    const total = totalInputTokens(us);
    const inputChars =
      typeof record.inputChars === "number"
        ? record.inputChars
        : typeof total === "number"
          ? total * CHARS_PER_TOKEN
          : undefined;
    const rows: RowInput[] = [];
    if (typeof total === "number") {
      const cachedPct =
        typeof us.cacheRead === "number" && total > 0
          ? `→ ${Math.round((us.cacheRead / total) * 100)}% cache-read`
          : undefined;
      rows.push({
        label: "  Input:",
        chars: fmtKChars(inputChars ?? total * CHARS_PER_TOKEN),
        tokens: fmtKTokensFromTokens(total),
        share: cachedPct,
      });
    } else if (typeof us.input === "number") {
      rows.push({
        label: "  Input:",
        chars: fmtKChars(inputChars ?? us.input * CHARS_PER_TOKEN),
        tokens: fmtKTokensFromTokens(us.input),
      });
    }
    if (typeof record.payloadChars === "number") {
      rows.push({
        label: "     · Payload:",
        chars: fmtKChars(record.payloadChars),
        tokens: `~${fmtKTokensFromTokens(record.payloadEstTokens ?? estimateTokens(record.payloadChars))}`,
        share:
          typeof record.payloadSharePct === "number"
            ? `≈ ${record.payloadSharePct}% of input tokens`
            : undefined,
      });
    }
    if (typeof record.inputChars === "number" && typeof record.payloadChars === "number") {
      const msgsChars = record.inputChars - record.payloadChars;
      if (msgsChars > 0) {
        rows.push({
          label: record.handshakeSent ? "     · handshake msg:" : "     · user msg:",
          chars: fmtKChars(msgsChars),
          // tokens are a tiny guesstimate that can round to 0 — keep the
          // row honest by showing the chars only
        });
      }
    }
    if (typeof us.output === "number") {
      rows.push({
        label: "  Output:",
        chars: fmtKChars(record.outputChars ?? us.output * CHARS_PER_TOKEN),
        tokens: fmtKTokensFromTokens(us.output),
      });
    }
    if (rows.length > 0) out.push(...renderAlignedRows(rows));
    if (typeof us.cost === "number") out.push(`  Cost:            ${fmtCost(us.cost) ?? "—"}`);
    const billing: string[] = [];
    if (typeof us.cacheRead === "number") billing.push(`cache-read ${fmtKTokensFromTokens(us.cacheRead)} K-tokens`);
    if (typeof us.input === "number" && typeof us.cacheRead === "number") billing.push(`fresh ${fmtKTokensFromTokens(us.input)} K-tokens`);
    if (typeof us.cacheWrite === "number" && us.cacheWrite > 0) billing.push(`cache-write ${fmtKTokensFromTokens(us.cacheWrite)} K-tokens`);
    if (typeof us.reasoning === "number" && us.reasoning > 0) billing.push(`reasoning ${fmtKTokensFromTokens(us.reasoning)} K-tokens`);
    if (billing.length > 0) out.push(`  Billing:         ${billing.join(" · ")}`);
    out.push(`  Usage: ${serialize(record.usage)}`);
  }
  console.log(out.join("\n"));

  pi.appendEntry(AUDIT_ENTRY, { ...record });
  pi.events.emit("ppa:audit", record);
}

/** Inline transcript card (TUI-only). */
const renderAuditCard: EntryRenderer<AuditRecord> = (entry, { expanded }, theme) => {
  const rec: Partial<AuditRecord> = entry.data ?? {};
  const dim = (s: string) => theme.fg("dim", s);
  const muted = (s: string) => theme.fg("muted", s);
  const accent = (s: string) => theme.fg("accent", s);
  const big = (s: string) => theme.fg("accent", theme.bold(s));
  const clamp = (s: string, max: number) => (s.length > max ? s.slice(0, max - 3) + "..." : s);

  const lines: string[] = [];
  const phase = String(rec.phase ?? "?").toUpperCase();
  // Header carries a short time only when expanded — the collapsed teaser
  // stays clean (Q9).
  const at = (rec.at ?? "").replace("T", " ").slice(11, 19);
  const atOk = /^\d{2}:\d{2}:\d{2}$/.test(at);
  lines.push(`${accent("🔍 PPA " + phase)}${expanded && atOk ? muted(`  ${at}`) : ""}`);
  // Reason code — one shared line above the table, for teaser AND expanded
  // (payload records only; usage has none).
  if (rec.reason) lines.push(`${muted("  reason:")}  ${dim(String(rec.reason))}`);

  if (rec.usage) {
    const us = usageNumbers(rec.usage);
    const total = totalInputTokens(us);
    // Input is the parent; Payload (the dominant component) nests under it;
    // Output is a peer. Token figures are real provider numbers (no ~);
    // chars are measured when available (payload record + session messages),
    // else derived from the real token count (tokens × 4 heuristic).
    const inputChars =
      typeof rec.inputChars === "number"
        ? rec.inputChars
        : typeof total === "number"
          ? total * CHARS_PER_TOKEN
          : undefined;
    const rows: RowInput[] = [];
    if (typeof total === "number") {
      const cachedPct =
        typeof us.cacheRead === "number" && total > 0
          ? `→ ${Math.round((us.cacheRead / total) * 100)}% cache-read`
          : undefined;
      rows.push({
        label: "  Input:",
        chars: fmtKChars(inputChars ?? total * CHARS_PER_TOKEN),
        tokens: fmtKTokensFromTokens(total),
        share: cachedPct,
      });
    } else if (typeof us.input === "number") {
      rows.push({
        label: "  Input:",
        chars: fmtKChars(inputChars ?? us.input * CHARS_PER_TOKEN),
        tokens: fmtKTokensFromTokens(us.input),
      });
    }
    if (typeof rec.payloadChars === "number") {
      rows.push({
        label: "   · Payload:",
        chars: fmtKChars(rec.payloadChars),
        tokens: `~${fmtKTokensFromTokens(rec.payloadEstTokens ?? estimateTokens(rec.payloadChars))}`,
        share:
          typeof rec.payloadSharePct === "number"
            ? `≈ ${rec.payloadSharePct}% of input tokens`
            : undefined,
      });
    }
    // the non-payload input text — normally the handshake user turn itself
    if (typeof rec.inputChars === "number" && typeof rec.payloadChars === "number") {
      const msgsChars = rec.inputChars - rec.payloadChars;
      if (msgsChars > 0) {
        rows.push({
          label: rec.handshakeSent ? "   · handshake msg:" : "   · user msg:",
          chars: fmtKChars(msgsChars),
        });
      }
    }
    if (typeof us.output === "number") {
      rows.push({
        label: "  Output:",
        chars: fmtKChars(rec.outputChars ?? us.output * CHARS_PER_TOKEN),
        tokens: fmtKTokensFromTokens(us.output),
      });
    }
    for (const r of alignCells(rows)) {
      const anchor = r.label === "  Input:";
      const fig = (s: string) => (anchor ? big(s) : dim(s));
      let line = `${muted(r.label)}  ${fig(`${r.chars} K-chars`)}${r.tokens ? `  ${fig(`${r.tokens} K-tokens`)}` : ""}`;
      if (r.share) line += `  ${dim(r.share)}`;
      lines.push(line);
    }
    if (typeof us.cost === "number") lines.push(`${muted("  Cost:")}  ${fmtCost(us.cost) ?? "—"}`);
    // usage is always-full (Q4): collapsed ≈ expanded, so no detail is gated
    // on the flag. totalTokens stays on the console line + "/ppa json".
    const billing: string[] = [];
    if (typeof us.cacheRead === "number") billing.push(`cache-read ${fmtKTokensFromTokens(us.cacheRead)} K`);
    if (typeof us.input === "number" && typeof us.cacheRead === "number") billing.push(`fresh ${fmtKTokensFromTokens(us.input)} K`);
    if (typeof us.cacheWrite === "number" && us.cacheWrite > 0) billing.push(`cache-write ${fmtKTokensFromTokens(us.cacheWrite)} K`);
    if (typeof us.reasoning === "number" && us.reasoning > 0) billing.push(`reasoning ${fmtKTokensFromTokens(us.reasoning)} K`);
    if (billing.length > 0) lines.push(dim(`  Billing:  ${billing.join(" · ")} tokens`));
    lines.push(dim("  (raw usage on console)"));
  } else {
    const totalChars = Number(rec.totalChars ?? 0);
    /** every row carries its % share of this phase's total */
    const shareFor = (chars: number): string | undefined => {
      if (totalChars <= 0 || chars <= 0) return undefined;
      const pct = Math.round((chars / totalChars) * 100);
      return pct > 0 ? `${pct}%` : undefined;
    };
    const tools = rec.tools ?? [];
    const toolsChars = tools.reduce((n, t) => n + t.chars, 0);
    const messages = rec.messages ?? [];
    const messagesChars = messages.reduce((n, m) => n + m.chars, 0);
    const sections = rec.systemSections ?? [];

    if (!expanded) {
      // ----- collapsed: teaser (no timestamp — Q9) -----
      if (rec.phase === "payload") {
        // Teaser: TOTAL anchor + top tool + top section + counts.
        const teaserRows: RowInput[] = [kRow("TOTAL:", totalChars)];
        const topTool = tools[0]; // toolMetas() sorts desc by chars
        const topSection = [...sections].sort((a, b) => b.chars - a.chars)[0];
        if (topTool) {
          teaserRows.push({ ...kRow(`· ${clamp(topTool.name, 28)}`, topTool.chars), share: shareFor(topTool.chars) });
        }
        if (topSection) {
          teaserRows.push({ ...kRow(`· ${clamp(topSection.label, 28)}`, topSection.chars), share: shareFor(topSection.chars) });
        }
        for (const [i, r] of alignCells(teaserRows).entries()) {
          let line = `${muted(r.label)}  ${dim(`${r.chars} K-chars`)}${r.tokens ? `  ${dim(`${r.tokens} K-tokens`)}` : ""}`;
          if (r.share) line += `  ${dim(r.share)}`;
          if (i === 0) line += " ▾";
          lines.push(line);
        }
        lines.push(dim(`· ${tools.length} tools · ${sections.length} sections ▾`));
      }
    } else {
      // ----- expanded: full unfurl (caps are only safety valves) -----
      if (totalChars > 0) {
        lines.push(`${big(`${fmtKChars(totalChars)} K-chars`)}${muted(` (~${fmtKTokens(totalChars)} K-tokens)`)}`);
      }
      const rows: RowInput[] = [];
      if (rec.systemChars) {
        rows.push({ ...kRow("System prompt:", rec.systemChars), share: shareFor(rec.systemChars) });
        for (const s of sections) {
          rows.push({ ...kRow(`   · ${clamp(s.label, 28)}:`, s.chars), share: shareFor(s.chars) });
        }
      }
      if (tools.length > 0) {
        rows.push({ ...kRow(`Tools (${tools.length}):`, toolsChars), share: shareFor(toolsChars) });
        for (const t of tools.slice(0, 30)) {
          rows.push({ ...kRow(`   · ${clamp(t.name, 30)}:`, t.chars), share: shareFor(t.chars) });
        }
      }
      if (messages.length > 0 || rec.messages !== undefined) {
        rows.push(kRow(`Messages (${messages.length}):`, messagesChars));
        for (const m of messages.slice(0, 15)) {
          rows.push(kRow(`   · [${m.index}] (${m.role}):`, m.chars));
        }
      }
      for (const r of alignCells(rows)) {
        let line = `${muted(r.label)}  ${dim(`${r.chars} K-chars`)}${r.tokens ? `  ${dim(`${r.tokens} K-tokens`)}` : ""}`;
        if (r.share) line += `  ${dim(r.share)}`;
        lines.push(line);
      }
      if (tools.length > 30) lines.push(dim(`   · … ${tools.length - 30} more tools`));
      if (messages.length > 15) lines.push(dim(`   · … ${messages.length - 15} more messages`));
    }
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

  pi.registerEntryRenderer<AuditRecord>(AUDIT_ENTRY, renderAuditCard);

  let handshakeQueued = false;
  /** session-start reason code, stamped onto the payload record (cold phase is gone — the payload is the cold-start audit now) */
  let sessionReason: SessionStartReason | undefined;

  pi.on("session_start", async (event, ctx) => {
    sessionReason = event.reason;

    if (
      !handshakeQueued &&
      !pi.getFlag(NO_HANDSHAKE_FLAG) &&
      process.env.PPA_HANDSHAKE !== "0" &&
      ctx.hasUI &&
      (sessionReason === "startup" || sessionReason === "new")
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

  pi.on("before_agent_start", (event, ctx) => {
    // once per session — the transcript is the guard (survives /reload):
    // stay quiet if a payload audit is already recorded in this session
    if (findAudit(ctx, "payload")) return;

    const sections = systemSections(event.systemPromptOptions ?? {});

    const tools = toolMetas(pi);
    const messages = sessionMessages(ctx);
    const toolsChars = tools.reduce((n, t) => n + t.chars, 0);
    const messagesChars = messages.reduce((n, m) => n + serialize(m).length, 0);
    const systemChars = event.systemPrompt?.length ?? 0;
    const totalChars = systemChars + toolsChars + messagesChars;

    emit(pi, {
      phase: "payload",
      at: new Date().toISOString(),
      sessionFile: ctx.sessionManager.getSessionFile() ?? undefined,
      reason: sessionReason,
      systemChars,
      systemSections: sections,
      tools,
      messageCount: messages.length,
      messages: recordMessages(messages),
      totalChars,
    });
  });

  pi.on("turn_end", (event, ctx) => {
    const usage = "usage" in event.message ? event.message.usage : undefined;
    if (!usage) return;
    // once per session — the transcript is the guard (survives /reload)
    if (findAudit(ctx, "usage")) return;

    const record: AuditRecord = {
      phase: "usage",
      at: new Date().toISOString(),
      sessionFile: ctx.sessionManager.getSessionFile() ?? undefined,
      usage,
      messageCount: 0,
      // tells the card/console whether the non-payload input text is the
      // automatic handshake turn (else it's a user-typed message)
      handshakeSent: handshakeQueued,
    };

    // Measured chars, not derived: the input text is known and countable.
    // The payload record already measured the pre-LLM payload (system prompt,
    // tool schemas, prior messages); at turn_end we add the non-assistant
    // session messages (e.g. the handshake user turn) to get the full input
    // text — and we serialize the assistant message just produced for output.
    const payload = findAudit(ctx, "payload");
    const usN = usageNumbers(usage);
    const inputTotal = totalInputTokens(usN);
    const inputMsgs = sessionMessages(ctx).filter(
      (m) => String(m.role ?? "?").toLowerCase() !== "assistant",
    );
    const inputMsgChars = inputMsgs.reduce((n, m) => n + serialize(m).length, 0);

    if (payload?.totalChars !== undefined && payload.totalChars > 0) {
      record.payloadChars = payload.totalChars;
      record.inputChars = payload.totalChars + inputMsgChars;
      if (inputTotal !== undefined && inputTotal > 0) {
        const est = estimateTokens(payload.totalChars);
        record.payloadEstTokens = est;
        record.payloadSharePct = Math.round((est / inputTotal) * 100);
      }
    }
    record.outputChars = serialize(event.message).length;

    emit(pi, record);

    if (ctx.hasUI) {
      const us = usageNumbers(usage);
      const total = totalInputTokens(us);
      const parts: string[] = [];
      if (typeof total === "number") {
        const chars = typeof record.inputChars === "number" ? ` (${fmtKChars(record.inputChars)} K-chars)` : "";
        parts.push(`${fmtKTokensFromTokens(total)} K-tokens input${chars}`);
        if (typeof us.cacheRead === "number" && total > 0) {
          parts.push(`(${Math.round((us.cacheRead / total) * 100)}% cache-read)`);
        }
      }
      if (typeof us.cost === "number") parts.push(`≈${fmtCost(us.cost) ?? ""}`);
      ctx.ui.notify(
        `PPA baseline captured: ${parts.join(" ") || "first turn"} — card in transcript, full detail on console`,
        "info",
      );
    }
  });

  pi.registerCommand("ppa", {
    description: "PPA: re-run the payload audit on the current session state (reason: manual)",
    getArgumentCompletions: (prefix: string) =>
      ["json"]
        .filter((a) => a.startsWith(prefix))
        .map((a) => ({ value: a, label: a })),
    handler: async (args: string, ctx) => {
      const entries = ctx.sessionManager
        .getEntries()
        .filter((e): e is CustomEntry<AuditRecord> => e.type === "custom" && e.customType === AUDIT_ENTRY);

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

      // Manual re-run of the payload phase on current state: same record
      // shape, same console + card paths (the cold phase was removed — the
      // payload IS the cold-start audit now). systemChars uses the real built
      // prompt when available, falling back to the six-section sum.
      const sections = systemSections(ctx.getSystemPromptOptions());
      const tools = toolMetas(pi);
      const messages = sessionMessages(ctx);
      const toolsChars = tools.reduce((n, t) => n + t.chars, 0);
      const messagesChars = messages.reduce((n, m) => n + serialize(m).length, 0);
      const systemChars =
        ctx.getSystemPrompt().length || sections.reduce((n, s) => n + s.chars, 0);
      const totalChars = systemChars + toolsChars + messagesChars;

      emit(pi, {
        phase: "payload",
        at: new Date().toISOString(),
        reason: "manual",
        sessionFile: ctx.sessionManager.getSessionFile() ?? undefined,
        systemChars,
        systemSections: sections,
        tools,
        messageCount: messages.length,
        messages: recordMessages(messages),
        totalChars,
      });
      ctx.ui.notify(
        `PPA audit logged (${entries.length + 1} total in this session; see console or /session)`,
        "info",
      );
    },
  });
}
