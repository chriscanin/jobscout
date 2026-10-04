/**
 * Shared presentational atoms for the ledger UI: difficulty/status chips and
 * the tinted match-score number. Pure markup — no data access.
 */
import type { Difficulty, Status } from "@jobscout/core";

export function DifficultyChip({ value }: { value: Difficulty }) {
  return <span className={`chip chip-${value}`}>{value}</span>;
}

export function StatusChip({ value }: { value: Status }) {
  return <span className={`chip chip-status-${value}`}>{value}</span>;
}

export function Score({ value }: { value: number | null }) {
  if (value == null) return <span className="muted">—</span>;
  const tone = value >= 70 ? "score-high" : value >= 50 ? "score-mid" : "score-low";
  return <span className={`score ${tone}`}>{value}</span>;
}

/**
 * Compact "Jul 28" date for ledger cells, with the year added ("Jul 28, 2025")
 * when it is not the current year; em-dash when missing.
 */
export function shortDate(iso: string | Date | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}
