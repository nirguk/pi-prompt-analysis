import { fmtKChars, fmtKTokens, renderAlignedRows, type RowInput } from "../extensions/lib/format.ts";
import { writeFileSync } from "node:fs";

function kRow(label: string, chars: number, share?: string): RowInput {
  return { label, chars: fmtKChars(chars), tokens: `~${fmtKTokens(chars)}`, share };
}
/** % share of this phase's total (matching emit()'s shareFor). */
function shareFor(chars: number, total: number): string | undefined {
  if (total <= 0 || chars <= 0) return undefined;
  const pct = Math.round((chars / total) * 100);
  return pct > 0 ? `${pct}%` : undefined;
}
const t = 43720; // tools chars (19 tools, real session)
const sys = 15682; // system prompt chars (real session)
const total = t + sys;
const sections: Array<[string, number]> = [
  ["context files", 6619],
  ["guidelines", 3987],
  ["skills", 3134],
];

const payload: RowInput[] = [
  kRow("  System Prompt:", sys, shareFor(sys, total)),
  ...sections.map(([label, chars]) => kRow(`     · ${label}:`, chars, shareFor(chars, total))),
  kRow("  Tools (19):", t, shareFor(t, total)),
  kRow("     · subagent:", 19244, shareFor(19244, total)),
  kRow("  Messages (0):", 0),
  kRow("  TOTAL BASELINE:", total),
];

const block = `🔍 [PPA: payload] (2025-01-07T10:00:00.000Z)
  reason:       startup
  session:      /path/to/session.jsonl
  -----------------------------------------
${renderAlignedRows(payload).join("\n")}
  (payload rows carry their % share of the total.)

🔍 [PPA: usage] (2025-01-07T10:00:00.000Z)
  session:      /path/to/session.jsonl
  Input:          59.5 K-chars   15.5 K-tokens       → 99% cache-read
     · Payload:   59.4 K-chars  ~14.9 K-tokens  ≈ 96% of input tokens
     · handshake msg:  0.1 K-chars
  Output:          1.7 K-chars    0.1 K-tokens
  Cost:            $0.0005
  Billing:         cache-read 15.4 K-tokens · fresh 0.2 K-tokens · reasoning 0.1 K-tokens
  Usage: { "input":187, "output":128, "cacheRead":15360, ... }`;

console.log(block);
writeFileSync("/tmp/readme-block.txt", block + "\n");