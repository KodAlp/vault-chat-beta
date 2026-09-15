/**
 * Character budgets for user skill files (data/skills/*.md).
 *
 * Lives in $lib rather than $lib/server/userSkills.ts, which owns the actual
 * enforcement, because /settings/skills has to render the very same numbers —
 * and used to do it with three separate hardcoded 4000s. A server-side budget
 * change then left the UI quietly showing a limit that no longer existed.
 *
 * Raised from 4000/16000: a single skill can now be a genuinely detailed
 * instruction sheet. Note this is a budget, not free space — everything kept
 * here is prepended to every request in scope, and a local model running at
 * Ollama's default 4096-token context will feel a full budget long before a
 * cloud model does.
 */
export const MAX_SKILL_FILE_CHARS = 32000;

/** Total across all enabled, in-scope skills; lowest priority is dropped
 * first once exceeded (see loadUserSkills). */
export const MAX_SKILL_TOTAL_CHARS = 256000;
