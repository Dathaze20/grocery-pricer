/**
 * Sorting what the app is telling the owner into what it means.
 *
 * A real order came back with two dozen notes, most of them saying a discount had been listed
 * twice and counted once - which is the app working correctly, filed under "What could not be
 * read". Buried among them were the notes that matter: a photograph that would not read, a
 * discount nobody could place. A list where everything is a problem is a list where nothing is.
 *
 * Sorted by what the text says, because that is what there is: these notes are stored as
 * sentences on orders that were read months ago, and nothing here may require them to be
 * written again. Anything unrecognised is treated as needing review - an unknown note is more
 * likely to be a real problem than a success story, and the safe mistake is the loud one.
 */
export const WarningKind = {
  /** The app dealt with it. Worth saying, not worth worrying about. */
  HANDLED: 'HANDLED',
  /** Something is missing or uncertain and only the owner can settle it. */
  REVIEW: 'REVIEW',
  /** Part of the receipt never arrived. */
  UNREAD: 'UNREAD',
} as const;
export type WarningKind = (typeof WarningKind)[keyof typeof WarningKind];

/** A duplicate the app collapsed by itself, and said so. */
const HANDLED = /\b(listed twice|counted once)\b/i;

/** A photograph or a group of them that never came back. */
const UNREAD = /^Photos? \d|could not be read:|did not come back/i;

export function warningKind(warning: string): WarningKind {
  if (UNREAD.test(warning)) return WarningKind.UNREAD;
  if (HANDLED.test(warning)) return WarningKind.HANDLED;
  return WarningKind.REVIEW;
}

export interface SortedWarnings {
  readonly handled: readonly string[];
  readonly review: readonly string[];
  readonly unread: readonly string[];
}

export function sortWarnings(warnings: readonly string[]): SortedWarnings {
  const handled: string[] = [];
  const review: string[] = [];
  const unread: string[] = [];
  for (const warning of warnings) {
    switch (warningKind(warning)) {
      case WarningKind.HANDLED:
        handled.push(warning);
        break;
      case WarningKind.UNREAD:
        unread.push(warning);
        break;
      default:
        review.push(warning);
    }
  }
  return { handled, review, unread };
}
