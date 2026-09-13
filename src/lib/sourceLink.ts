/** Always works — reads straight from data/library/ regardless of the
 * source's origin. `vaultId` is required, not optional (Faz 14): without
 * it, /api/library/file falls back to whatever vault happens to be
 * "active" — silently correct as long as the user hasn't switched vaults
 * since the item being viewed was generated, silently wrong (404, or in
 * principle a same-path collision from a different vault) otherwise. */
export function libraryViewerUrl(path: string, vaultId: string): string {
	const params = new URLSearchParams({ path, vault: vaultId });
	return `/library/view?${params.toString()}`;
}
