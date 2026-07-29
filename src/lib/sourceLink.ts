import { env } from '$env/dynamic/public';

const VAULT_NAME = env.PUBLIC_VAULT_NAME ?? '';

/** Works for anything still reachable in the actual Obsidian vault (existing
 * wiki/ content, or vault-imported library files that kept the same relative
 * path). Silently 404s inside Obsidian for library-native (uploaded/
 * converted) sources that never existed there — libraryViewerUrl covers
 * those instead. */
export function obsidianUri(path: string): string {
	const params = new URLSearchParams({ vault: VAULT_NAME, file: path.replace(/\.md$/, '') });
	return `obsidian://open?${params.toString()}`;
}

/** Always works — reads straight from data/library/ regardless of the
 * source's origin. */
export function libraryViewerUrl(path: string): string {
	return `/library/view?path=${encodeURIComponent(path)}`;
}
