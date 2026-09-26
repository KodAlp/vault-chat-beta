/**
 * Module-level $state, not component-local — the citation → source-tree
 * highlight has to connect two components (SourceChip.svelte, rendered
 * inside the chat transcript, and SourceTreeNode.svelte, rendered in the
 * left panel) that share no parent close enough to pass this as a prop
 * without threading it through several unrelated layers. Same reasoning as
 * quiz-generation.svelte.ts's `quizGeneration` store — see that file's doc
 * comment.
 *
 * Boxed in a const object on purpose: Svelte 5 forbids exporting a `let`
 * $state binding that gets reassigned (compiler error state_invalid_export)
 * — only mutating a property of an exported const is allowed. Consumers
 * read `sourceHighlight.path`, never reassign `sourceHighlight` itself.
 *
 * A single `path | null` slot, not a Set or a stack — only one citation can
 * be hovered/focused at a time, and the last writer always wins (a pointer
 * leaving one chip before entering the next, or a focus move, both replace
 * whatever was there rather than needing to merge with it).
 *
 * `path` is compared for equality against both RetrievedChunk.path and
 * LibraryNode.path with no normalization step — both already share the same
 * form (library-root-relative, forward-slash separated, `.md` extension
 * included; see incrementalIndex.ts's relPath and library-read.ts's
 * walkTree, which build the exact same string from the exact same file).
 */
export const sourceHighlight = $state<{ path: string | null }>({ path: null });

/** Sets the highlighted path unconditionally — used for an immediate (no
 * intent-delay) highlight, e.g. on keyboard focus. */
export function setHighlight(path: string): void {
	sourceHighlight.path = path;
}

/** Clears the highlight only if it still points at `path` — a second chip's
 * pointerenter/focusin may already have overwritten it (or the delayed
 * timer for a THIRD, since-abandoned hover may fire late), and neither of
 * those should be able to erase a highlight some other, still-active chip
 * just set. */
export function clearHighlight(path: string): void {
	if (sourceHighlight.path === path) sourceHighlight.path = null;
}
