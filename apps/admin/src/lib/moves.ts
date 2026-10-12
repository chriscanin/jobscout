import type { PersonStatus } from "@jobscout/core";

/** One button on a posting: the label and the personal status it moves to. */
export interface Move {
  label: string;
  to: PersonStatus;
  primary: boolean;
}

/**
 * The buttons for a posting given the viewer's own status. Mirrors
 * PERSONAL_TRANSITIONS in @jobscout/core (a test holds them in step).
 */
export function movesFor(status: PersonStatus | null): Move[] {
  switch (status) {
    case null:
      return [
        { label: "Queue", to: "queued", primary: true },
        { label: "Dismiss", to: "dismissed", primary: false },
      ];
    case "queued":
      return [
        { label: "Applied", to: "applied", primary: true },
        { label: "Dismiss", to: "dismissed", primary: false },
      ];
    case "applied":
    case "dismissed":
      return [{ label: "Undo", to: "queued", primary: false }];
  }
}
