import type { Status } from "./enums.js";

/**
 * The status machine from CONTRACT §Status machine. Pure, no DB.
 *
 * Allowed transitions (11 pairs):
 *   new       -> notified   (notifier, after a successful Discord post)
 *   new       -> queued     (admin)
 *   new       -> dismissed  (admin)
 *   notified  -> queued     (admin)
 *   notified  -> dismissed  (admin)
 *   queued    -> applied    (admin)
 *   queued    -> dismissed  (admin)
 *   applied   -> queued     (admin, undo)
 *   dismissed -> queued     (admin, undo)
 *   new       -> expired    (crawler, missing_streak >= 2)
 *   notified  -> expired    (crawler, missing_streak >= 2)
 *
 * No other transitions.
 */
export const ALLOWED_TRANSITIONS: ReadonlyArray<readonly [Status, Status]> = [
  ["new", "notified"],
  ["new", "queued"],
  ["new", "dismissed"],
  ["notified", "queued"],
  ["notified", "dismissed"],
  ["queued", "applied"],
  ["queued", "dismissed"],
  ["applied", "queued"],
  ["dismissed", "queued"],
  ["new", "expired"],
  ["notified", "expired"],
];

export function isAllowedTransition(from: Status, to: Status): boolean {
  return ALLOWED_TRANSITIONS.some(([f, t]) => f === from && t === to);
}

/**
 * Pure guard: throws `InvalidTransitionError` if the transition is not allowed.
 * Same rules as `isAllowedTransition` — no DB access, fully synchronous.
 * Used by server actions to re-check before writing, and in unit tests.
 */
export function assertTransition(from: Status, to: Status): void {
  if (!isAllowedTransition(from, to)) {
    throw new InvalidTransitionError(from, to);
  }
}

/** Thrown when a status transition is not permitted by the status machine. */
export class InvalidTransitionError extends Error {
  readonly from: Status;
  readonly to: Status;
  constructor(from: Status, to: Status) {
    super(`invalid status transition: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
    this.from = from;
    this.to = to;
  }
}
