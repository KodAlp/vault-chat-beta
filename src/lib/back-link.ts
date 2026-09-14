/**
 * Every artifact page (a study item, the library file viewer) used to
 * hardcode its "Ana sayfa" back link to `/` — the vault picker — no matter
 * where the user actually came from (a chat screen, another artifact's
 * source citation, StudyPanel's recent list, a generation-done toast).
 * Callers that NAVIGATE to one of those pages attach the current page's own
 * path+search as a `from` query param (see StudyPanel.svelte's openItem,
 * +layout.svelte's studyUrl, sourceLink.ts's libraryViewerUrl); the page
 * being navigated TO reads it back via resolveBackHref below.
 */

/** Same-origin relative-path check for a `from` value pulled out of the
 * URL — this app is loopback-only with no auth, but `from` is still
 * user-controllable input (a hand-edited URL, a stale bookmark), so it is
 * validated before ever being used as a navigation target: must be a
 * genuine relative path ("/…"), not a protocol-relative URL ("//evil…")
 * that a browser resolves as "same scheme, different host". */
function isSafeRelativePath(value: string): boolean {
	return value.startsWith('/') && !value.startsWith('//');
}

/** Resolves a `from` query param into a safe back-navigation target, or
 * `fallback` when it is absent or not a safe relative path (a direct visit,
 * an old bookmark, or a link from before this existed). */
export function resolveBackHref(fromParam: string | null, fallback: string): string {
	if (fromParam && isSafeRelativePath(fromParam)) return fromParam;
	return fallback;
}
