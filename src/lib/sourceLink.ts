/** Always works — reads straight from data/library/ regardless of the
 * source's origin. `vaultId` is required, not optional (Faz 14): without
 * it, /api/library/file falls back to whatever vault happens to be
 * "active" — silently correct as long as the user hasn't switched vaults
 * since the item being viewed was generated, silently wrong (404, or in
 * principle a same-path collision from a different vault) otherwise. */
/** `from`: the current page's own path+search, so /library/view's back
 * link (see back-link.ts) returns to the exact artifact the citation was
 * clicked from, instead of a hardcoded home link. Optional — a caller with
 * no reasonable "current page" to offer (none exist today; kept optional
 * so a future one doesn't need a placeholder) just gets the old behavior. */
export function libraryViewerUrl(path: string, vaultId: string, from?: string): string {
	const params = new URLSearchParams({ path, vault: vaultId });
	if (from) params.set('from', from);
	return `/library/view?${params.toString()}`;
}
