/*
 * Verify the ppa formatting helpers without running a TUI:
 *
 *   node scripts/verify-format.ts
 *
 * Checks fixed-value formatters and — the important part — that a rendered
 * breakdown has NO wobble: every decimal point in the K-chars column and in
 * the K-tokens column must land on the same character offset in every row.
 */
import {
  alignCells,
  estimateTokens,
  fmtKChars,
  fmtKTokens,
  fmtKTokensFromTokens,
  renderAlignedRows,
} from "../extensions/lib/format.ts";

let failures = 0;
function eq(actual: string, expected: string, what: string): void {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${what}: got "${actual}", want "${expected}"`);
}
function check(cond: boolean, what: string): void {
  if (!cond) failures += 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${what}`);
}

// ---- fixed values -------------------------------------------------------
eq(fmtKChars(0), "0.0", "fmtKChars(0)");
eq(fmtKChars(900), "0.9", "fmtKChars(900)");
eq(fmtKChars(1000), "1.0", "fmtKChars(1000)");
eq(fmtKChars(15332), "15.3", "fmtKChars(15332)");
eq(fmtKChars(1234567), "1,234.6", "fmtKChars(1234567)");
eq(fmtKChars(2_345_678_000), "2,345,678.0", "fmtKChars(2345678000)");
eq(fmtKTokens(0), "0.0", "fmtKTokens(0)");
eq(fmtKTokens(900), "0.2", "fmtKTokens(900)"); // ceil(225)/1000 → 0.225 → 0.2
eq(fmtKTokens(1234567), "308.6", "fmtKTokens(1234567)"); // ceil(308641.75)/1000 → 308.6
eq(fmtKTokensFromTokens(1203), "1.2", "fmtKTokensFromTokens(1203)");
eq(fmtKTokensFromTokens(0), "0.0", "fmtKTokensFromTokens(0)");
eq(String(estimateTokens(900)), "225", "estimateTokens(900)");

// ---- wobble check: render a realistic breakdown -------------------------
function row(label: string, chars: number): { label: string; chars: string; tokens: string } {
  return { label, chars: fmtKChars(chars), tokens: `~${fmtKTokens(chars)}` };
}

const sampleRows = [
  row("System prompt:", 12_345),
  row("   · Guidelines:", 900),
  row("   · appendSystemPrompt:", 47_100),
  row("Tools (23):", 156_700),
  row("   · eval:", 12_300),
  row("   · findtree:", 10_100),
  row("Messages (12):", 205_800),
  row("   · [0] (user):", 18_100),
  { label: "TOTAL BASELINE:", chars: fmtKChars(1_234_567), tokens: `~${fmtKTokens(1_234_567)}` },
];

console.log("\nSample breakdown (aligned):");
for (const line of renderAlignedRows(sampleRows)) console.log(`  ${line}`);

console.log("\nSample aligned cells (colour-safe, card use):");
for (const c of alignCells(sampleRows)) {
  console.log(`  [${c.label}] [${c.chars}${" K-chars"}] [${c.tokens}${" K-tokens"}]`);
}

const dotCol = (line: string, unit: string): number => {
  const u = line.indexOf(unit);
  return u === -1 ? -1 : line.lastIndexOf(".", u);
};
const sample = renderAlignedRows(sampleRows);
const kCols = sample.map((l) => dotCol(l, " K-chars"));
const tCols = sample.map((l) => dotCol(l, " K-tokens"));
check(new Set(kCols).size === 1 && kCols[0] !== -1, `K-chars decimal column uniform (col ${kCols[0]})`);
check(new Set(tCols).size === 1 && tCols[0] !== -1, `K-tokens decimal column uniform (col ${tCols[0]})`);
check(
  new Set(sample.map((l) => l.indexOf(" K-chars"))).size === 1,
  "K-chars unit column uniform",
);

// ---- share column (e.g. a row's % of the phase total) ---------------------
const shared = [
  { label: "A:", chars: "1.0", tokens: "~0.3", share: "23%" },
  { label: "B:", chars: "2.0", tokens: "~0.5" },
  { label: "C:", chars: "10.0", tokens: "~2.5", share: "77%" },
];
const w = renderAlignedRows(shared);
eq(w[0]!, "A:   1.0 K-chars  ~0.3 K-tokens  23%", "share row rendered with cell");
eq(w[1]!.trimEnd(), "B:   2.0 K-chars  ~0.5 K-tokens", "shareless row leaves a blank cell");
eq(w[2]!, "C:  10.0 K-chars  ~2.5 K-tokens  77%", "widest share right-aligned");
const shareStart = w.map((l) => l.lastIndexOf(" K-tokens") + " K-tokens".length + 2);
check(
  new Set(shareStart).size === 1 && w[0]!.charAt(shareStart[0]!) !== " " && w[1]!.charAt(shareStart[0]!) === " ",
  `share cell start uniform at col ${shareStart[0]!}`,
);
console.log("\nSample shared rows (a row's % of the phase total):");
for (const line of w) console.log(`  ${line}`);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);