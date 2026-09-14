import { isTauri } from '@tauri-apps/api/core';

/**
 * Model-produced links used to open inside Tauri's own webview, navigating
 * the whole app away with no back button and no way to return short of
 * relaunching (İdeas.txt bug report). Every markdown-rendered link in the
 * app (chat messages, cards, quiz explanations, report sections, mindmap
 * summaries — anything through markdown.ts's renderMarkdown()) goes through
 * this instead: opened in the OS's default browser on desktop, a new tab in
 * a plain browser context.
 */
export async function openExternalLink(url: string): Promise<void> {
	if (isTauri()) {
		const { openUrl } = await import('@tauri-apps/plugin-opener');
		await openUrl(url);
		return;
	}
	window.open(url, '_blank', 'noopener,noreferrer');
}

function isModifiedClick(e: MouseEvent): boolean {
	// Anything but a plain left click (middle-click, ctrl/cmd/shift/alt+click)
	// keeps its native browser/OS behavior (new tab, new window, ...) —
	// only a plain click is worth overriding, and overriding a modified one
	// would surprise a user who explicitly asked for the native variant.
	return e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;
}

/**
 * Delegated document-level click handler — see +layout.svelte, where it's
 * wired via <svelte:document>. Delegated rather than attached per-component
 * because renderMarkdown() output lands in several independent places
 * (Message.svelte's bubbles, plus card/quiz/report/mindmap views), and a
 * per-page listener is one more thing to remember to add to the next one.
 * Internal app links (SourceChip, StudyPanel, every <a href="/..."> in this
 * codebase) are untouched — they never match the absolute-http(s) check
 * below and fall through to normal SvelteKit navigation.
 */
export function handleExternalLinkClick(e: MouseEvent): void {
	if (isModifiedClick(e)) return;
	const target = e.target;
	if (!(target instanceof Element)) return;
	const anchor = target.closest('a[href]');
	if (!anchor) return;
	const href = anchor.getAttribute('href') ?? '';
	if (!/^https?:\/\//i.test(href)) return;
	e.preventDefault();
	void openExternalLink(href);
}
