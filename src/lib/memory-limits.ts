/**
 * Character budget for the memory block injected into every chat prompt.
 *
 * Lives in $lib rather than $lib/server/memory-store.ts, which owns the actual enforcement, the same reason
 * skill-limits.ts is split out of userSkills.ts: a future settings UI showing "how much room is left" needs the
 * same number the server enforces.
 *
 * Picked, not measured — deliberately small given the documented prompt-size sensitivity on a 6 GB GPU (every
 * extra token here is paid on every single chat turn, not just when memory happens to be relevant). Revisit once
 * there is real usage to look at, the same way k=6/serveCtx are flagged as unmeasured defaults elsewhere.
 */
export const MEMORY_MAX_CHARS = 1200;

/** A single manual note is kept whole up to this length; derived (domain/weak-spot) content is trimmed first when
 * the total would exceed MEMORY_MAX_CHARS, since a note the user wrote themselves should not be cut off. */
export const MEMORY_MAX_NOTE_CHARS = 300;
