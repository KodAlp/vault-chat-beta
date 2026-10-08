/**
 * Pure policy for the opt-in "auto-confirm MCP imports" setting. No fs, no server
 * imports: the settings page uses AUTO_CONFIRM_MODES for its control, and the
 * server uses parse + shouldAutoConfirm to decide, so both sides share one list.
 *
 * Why this is safe to have at all: the MCP client still never confirms anything.
 * The APP confirms, on the user's standing instruction stored per vault, and that
 * instruction can only be written from the session-gated settings API (never
 * under /api/mcp/*, see mcp/no-auto-confirm-write.test.ts).
 */
export const AUTO_CONFIRM_MODES = ['off', 'clean', 'all'] as const;
export type AutoConfirmMode = (typeof AUTO_CONFIRM_MODES)[number];

/** Strict parse: anything that is not exactly one of the three strings is rejected (undefined), never coerced. */
export function parseAutoConfirmMode(raw: unknown): AutoConfirmMode | undefined {
	return typeof raw === 'string' && (AUTO_CONFIRM_MODES as readonly string[]).includes(raw) ? (raw as AutoConfirmMode) : undefined;
}

/** What the decision needs to know about one finished import. */
export interface AutoConfirmCandidate {
	status: string;
	by: 'mcp' | 'app';
	warnings: readonly string[];
	error?: unknown;
	/** Frontmatter `needs_review: true` on the staged note (converter fell back to a weaker backend). */
	needsReview: boolean;
	proposed: { title?: string; domain?: string };
}

/**
 * Whether the app should confirm this import by itself.
 * - `off`: never.
 * - `all`: every import that reached `ready` (errors stay errors).
 * - `clean`: only a `ready` import with NO warning at all (this also covers the
 *   duplicate-content/URL flags), no needs_review flag and no error.
 * Imports made by the user in the app are never auto-confirmed, whatever the mode:
 * the user is already at the confirm dialog for those.
 */
export function shouldAutoConfirm(mode: AutoConfirmMode, c: AutoConfirmCandidate): boolean {
	if (mode === 'off') return false;
	if (c.by !== 'mcp' || c.status !== 'ready' || c.error) return false;
	// The confirm step requires a title and a domain; a blank proposal needs a human, not a failed attempt.
	if (!c.proposed.title?.trim() || !c.proposed.domain?.trim()) return false;
	if (mode === 'all') return true;
	return c.warnings.length === 0 && !c.needsReview;
}
