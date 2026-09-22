/**
 * Constants for the REVIEW-mode block injected into the chat prompt when a chat is in review mode (F6).
 * Same split as memory-limits.ts and the same reason: picked, not measured — small on purpose given F12's
 * documented prompt-size sensitivity on a 6 GB GPU, revisit once there is real usage to look at.
 */

/** Character budget for the whole review block, independent of (and on top of) MEMORY_MAX_CHARS. */
export const REVIEW_MAX_CHARS = 1200;

/** Due cards are a prompt hint, not the review queue itself (that's /study/cards) — only the most overdue
 * few are named. */
export const REVIEW_MAX_DUE_CARDS = 5;

/** A domain with reliable mastery but no answered evidence in this many days counts as "long-unreviewed". */
export const STALE_DOMAIN_DAYS = 21;

/** Caps on weak domains / open weak spots shown, same numbers memory-runtime.ts's deriveMemorySignals already
 * uses for the memory block — kept here too since review-block.ts formats them independently. */
export const REVIEW_MAX_WEAK_DOMAINS = 3;
export const REVIEW_MAX_OPEN_WEAK_SPOTS = 3;
export const REVIEW_MAX_STALE_DOMAINS = 3;
