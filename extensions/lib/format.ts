/*
 * Pure formatting helpers for pi-prompt-analysis.
 *
 * No pi imports — plain erasable TypeScript, safe to run directly under
 * `node` (type-stripping) via scripts/verify-format.ts.
 *
 * Scaling rule (fixed, never changes per row):
 *   - sizes  are ALWAYS shown in K-chars  (chars ÷ 1000)
 *   - tokens are ALWAYS shown in K-tokens (tokens ÷ 1000)
 *   - exactly 1 decimal place, thousands separators on the integer part
 *   - zero → "0.0"
 *
 *   Examples: 900 chars → "0.9 K-chars"   ·  1,234,567 → "1,234.6 K-chars"
 *
 * Alignment (the wobble-free part): `alignCells`/`renderAlignedRows`
 * parameterize every row identically — the label column is padded to the
 * widest label, and each numeric cell is right-aligned ("padStart") to the
 * widest cell in its column. Because every figure has exactly one decimal
 * point, right-alignment lines the decimal points up by construction; the
 * unit suffix is appended AFTER the padded cell so it can never shift them.
 */

export const CHARS_PER_TOKEN = 4; // rough estimate: chars / 4 ≈ tokens

/** chars → tokens guesstimate (ceil). */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** 1dp figure with thousands separators; non-finite/≤0 → "0.0". */
export function fmtK(num: number): string {
  const n = Number(num);
  if (!Number.isFinite(n) || n <= 0) return "0.0";
  const rounded = Math.round(n * 10) / 10;
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(rounded);
}

/** chars → K-chars figure (chars ÷ 1000, 1dp, separators). */
export function fmtKChars(chars: number): string {
  return fmtK(chars / 1000);
}

/** chars → token guesstimate → K-tokens figure (1dp, separators). */
export function fmtKTokens(chars: number): string {
  return fmtK(estimateTokens(chars) / 1000);
}

/** real token count → K-tokens figure (usage rows). */
export function fmtKTokensFromTokens(tokens: number): string {
  return fmtK(tokens / 1000);
}

/** One logical row: label plus pre-formatted column figures. */
export interface RowInput {
  label: string;
  /** pre-formatted K-chars figure, bare number (e.g. "1,234.6") */
  chars: string;
  /** pre-formatted token figure — include "~" if it's a guesstimate */
  tokens?: string;
  /**
   * Optional right-aligned share cell (e.g. "32%") rendered after the
   * tokens column. Rows without a share leave a blank cell of the same
   * width, so the share column stays uniform across the block.
   */
  share?: string;
}

/** One aligned row: every cell already padded to its column's width. */
export interface AlignedRow {
  label: string;
  chars: string;
  tokens?: string;
  /** Padded share cell; blank when the column exists but the row has no share. */
  share?: string;
}

/**
 * Parameterize every row identically: pad the label to the widest label and
 * right-align each numeric cell to the widest cell in its column. Right-
 * alignment + exactly-one-decimal ⇒ decimal points align vertically.
 */
export function alignCells(rows: RowInput[]): AlignedRow[] {
  const labelW = rows.reduce((m, r) => Math.max(m, r.label.length), 0);
  const charsW = rows.reduce((m, r) => Math.max(m, r.chars.length), 0);
  const tokW = rows.reduce((m, r) => Math.max(m, r.tokens ? r.tokens.length : 0), 0);
  const shareW = rows.reduce((m, r) => Math.max(m, r.share ? r.share.length : 0), 0);
  return rows.map((r) => ({
    label: r.label.padEnd(labelW),
    chars: r.chars.padStart(charsW),
    tokens: r.tokens ? r.tokens.padStart(tokW) : undefined,
    share:
      shareW > 0
        ? r.share
          ? r.share.padStart(shareW)
          : " ".repeat(shareW)
        : undefined,
  }));
}

const DEFAULT_UNITS = { chars: " K-chars", tokens: " K-tokens" };

/**
 * alignCells + plain-text join with unit suffixes (for console output and
 * the verify script). The unit suffix always follows the padded cell, so
 * it never moves the decimal point.
 */
export function renderAlignedRows(
  rows: RowInput[],
  units: { chars: string; tokens: string } = DEFAULT_UNITS,
): string[] {
  return alignCells(rows).map((r) => {
    const base = r.tokens
      ? `${r.label}  ${r.chars}${units.chars}  ${r.tokens}${units.tokens}`
      : `${r.label}  ${r.chars}${units.chars}`;
    return r.share ? `${base}  ${r.share}` : base;
  });
}