<script lang="ts">
	/**
	 * Visual (WYSIWYG) Markdown editor on Milkdown 7. Imported ONLY via dynamic
	 * import() from the library viewer when the user enters edit mode, like
	 * MarkdownEditor.svelte (CodeMirror), so none of it is in the viewer bundle.
	 *
	 * Contract mirrors MarkdownEditor: `value` is the whole file (frontmatter
	 * included), `onchange` reports the whole file after every edit. Unlike
	 * CodeMirror, the text we report is assembled by note-blocks.ts so that
	 * every block the user did not touch is returned byte for byte.
	 */
	import '@milkdown/kit/prose/view/style/prosemirror.css';
	import '@milkdown/kit/prose/tables/style/tables.css';
	import { onMount } from 'svelte';
	import { t } from '$lib/i18n/index.svelte';
	import { createVisualEditor, type VisualEditor, type FormatState, type MathTarget, type ToolbarCommand } from '$lib/wysiwyg/visual-editor';
	import MathPopover from '$lib/components/MathPopover.svelte';
	import BoldIcon from '@lucide/svelte/icons/bold';
	import ItalicIcon from '@lucide/svelte/icons/italic';
	import StrikethroughIcon from '@lucide/svelte/icons/strikethrough';
	import CodeIcon from '@lucide/svelte/icons/code';
	import Heading1Icon from '@lucide/svelte/icons/heading-1';
	import Heading2Icon from '@lucide/svelte/icons/heading-2';
	import Heading3Icon from '@lucide/svelte/icons/heading-3';
	import PilcrowIcon from '@lucide/svelte/icons/pilcrow';
	import ListIcon from '@lucide/svelte/icons/list';
	import ListOrderedIcon from '@lucide/svelte/icons/list-ordered';
	import QuoteIcon from '@lucide/svelte/icons/quote';
	import LinkIcon from '@lucide/svelte/icons/link';
	import ImageIcon from '@lucide/svelte/icons/image';
	import TableIcon from '@lucide/svelte/icons/table';
	import SquareCodeIcon from '@lucide/svelte/icons/square-code';
	import Undo2Icon from '@lucide/svelte/icons/undo-2';
	import Redo2Icon from '@lucide/svelte/icons/redo-2';
	import SigmaIcon from '@lucide/svelte/icons/sigma';
	import SquareSigmaIcon from '@lucide/svelte/icons/square-sigma';
	import TableRowsSplitIcon from '@lucide/svelte/icons/table-rows-split';
	import TableColumnsSplitIcon from '@lucide/svelte/icons/table-columns-split';

	let {
		value,
		onchange,
		vaultId,
		currentPath,
		onfallback
	}: {
		value: string;
		onchange: (next: string) => void;
		vaultId: string;
		currentPath: string;
		/** Called instead of showing the editor when the note has too many blocks the gate had to lock. */
		onfallback: (reason: 'too-many-unsafe', count: number) => void;
	} = $props();

	const NO_FORMAT: FormatState = { bold: false, italic: false, strike: false, code: false, link: false, heading: 0, bullet: false, ordered: false, quote: false, codeblock: false, table: false, rawBlock: false };

	let host: HTMLDivElement;
	let editor: VisualEditor | undefined;
	let ready = $state(false);
	let failed = $state(false);
	let fmt = $state<FormatState>(NO_FORMAT);
	let math = $state<MathTarget | null>(null);
	let linkOpen = $state(false);
	let linkHref = $state('');
	let imageOpen = $state(false);
	let imageSrc = $state('');
	let imageAlt = $state('');
	// What we last told the parent; an incoming `value` equal to it is just our own echo.
	let lastEmitted = value;
	let loadedFor: string | null = null;

	function emit(next: string) {
		lastEmitted = next;
		onchange(next);
	}

	/** Parent calls this before saving / switching mode so a pending debounced edit is not lost. */
	export function flush(): string {
		if (!editor || !ready) return lastEmitted;
		const next = editor.getMarkdown();
		if (next !== lastEmitted) emit(next);
		return next;
	}

	async function loadValue(raw: string) {
		if (!editor) return;
		loadedFor = raw;
		const res = await editor.load(raw);
		if (!res.ok) {
			onfallback(res.reason, res.locked);
			return;
		}
		ready = true;
	}

	onMount(() => {
		let disposed = false;
		createVisualEditor({
			host,
			vaultId,
			currentPath,
			rawBlockTitle: t('WysiwygEditor.rawBlockTitle'),
			onChange: emit,
			onFormat: (s) => (fmt = s),
			onMath: (target) => (math = target)
		})
			.then(async (ed) => {
				if (disposed) {
					ed.destroy();
					return;
				}
				editor = ed;
				await loadValue(value);
			})
			.catch(() => {
				failed = true;
			});
		return () => {
			disposed = true;
			editor?.destroy();
			editor = undefined;
		};
	});

	// Parent replaced the file (reload from disk / restore / mode switch back): load it.
	$effect(() => {
		const next = value;
		if (editor && next !== lastEmitted && next !== loadedFor) {
			lastEmitted = next;
			ready = false;
			void loadValue(next);
		}
	});

	function run(cmd: ToolbarCommand) {
		editor?.exec(cmd);
	}

	function openLink() {
		if (fmt.link) {
			editor?.removeLink();
			return;
		}
		linkHref = '';
		imageOpen = false;
		linkOpen = true;
	}
	function applyLink() {
		const href = linkHref.trim();
		linkOpen = false;
		if (href) editor?.setLink(href);
		else editor?.focus();
	}
	function openImage() {
		imageSrc = '';
		imageAlt = '';
		linkOpen = false;
		imageOpen = true;
	}
	function applyImage() {
		const src = imageSrc.trim();
		imageOpen = false;
		if (src) editor?.insertImage(src, imageAlt.trim());
		else editor?.focus();
	}
	function insertFormula(kind: 'inline' | 'block') {
		const target = editor?.insertMath(kind);
		if (target) math = target;
	}
	function applyMath(latex: string) {
		const target = math;
		math = null;
		if (target) editor?.setMath(target.pos, latex);
	}
	function cancelMath() {
		math = null;
		editor?.focus();
	}

	// Ctrl+K belongs to the editor surface only; Ctrl+B/I/Z/Y come from the Milkdown keymaps.
	function onKeydown(e: KeyboardEvent) {
		if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k' && !fmt.rawBlock) {
			e.preventDefault();
			openLink();
		}
	}
</script>

<div class="vc-visual" class:busy={!ready && !failed} role="group" aria-label={t('WysiwygEditor.editorLabel')}>
	<div class="tb" role="toolbar" aria-label={t('WysiwygEditor.toolbar')}>
		<div class="grp">
			<button type="button" title={t('WysiwygEditor.undo')} aria-label={t('WysiwygEditor.undo')} onclick={() => run('undo')}><Undo2Icon size={16} aria-hidden="true" /></button>
			<button type="button" title={t('WysiwygEditor.redo')} aria-label={t('WysiwygEditor.redo')} onclick={() => run('redo')}><Redo2Icon size={16} aria-hidden="true" /></button>
		</div>
		<div class="grp">
			<button type="button" class:on={fmt.bold} aria-pressed={fmt.bold} title={t('WysiwygEditor.bold')} aria-label={t('WysiwygEditor.bold')} onclick={() => run('bold')}><BoldIcon size={16} aria-hidden="true" /></button>
			<button type="button" class:on={fmt.italic} aria-pressed={fmt.italic} title={t('WysiwygEditor.italic')} aria-label={t('WysiwygEditor.italic')} onclick={() => run('italic')}><ItalicIcon size={16} aria-hidden="true" /></button>
			<button type="button" class:on={fmt.strike} aria-pressed={fmt.strike} title={t('WysiwygEditor.strike')} aria-label={t('WysiwygEditor.strike')} onclick={() => run('strike')}><StrikethroughIcon size={16} aria-hidden="true" /></button>
			<button type="button" class:on={fmt.code} aria-pressed={fmt.code} title={t('WysiwygEditor.code')} aria-label={t('WysiwygEditor.code')} onclick={() => run('code')}><CodeIcon size={16} aria-hidden="true" /></button>
		</div>
		<div class="grp">
			<button type="button" class:on={fmt.heading === 1} aria-pressed={fmt.heading === 1} title={t('WysiwygEditor.h1')} aria-label={t('WysiwygEditor.h1')} onclick={() => run('h1')}><Heading1Icon size={16} aria-hidden="true" /></button>
			<button type="button" class:on={fmt.heading === 2} aria-pressed={fmt.heading === 2} title={t('WysiwygEditor.h2')} aria-label={t('WysiwygEditor.h2')} onclick={() => run('h2')}><Heading2Icon size={16} aria-hidden="true" /></button>
			<button type="button" class:on={fmt.heading === 3} aria-pressed={fmt.heading === 3} title={t('WysiwygEditor.h3')} aria-label={t('WysiwygEditor.h3')} onclick={() => run('h3')}><Heading3Icon size={16} aria-hidden="true" /></button>
			<button type="button" title={t('WysiwygEditor.paragraph')} aria-label={t('WysiwygEditor.paragraph')} onclick={() => run('paragraph')}><PilcrowIcon size={16} aria-hidden="true" /></button>
		</div>
		<div class="grp">
			<button type="button" class:on={fmt.bullet} aria-pressed={fmt.bullet} title={t('WysiwygEditor.bullet')} aria-label={t('WysiwygEditor.bullet')} onclick={() => run('bullet')}><ListIcon size={16} aria-hidden="true" /></button>
			<button type="button" class:on={fmt.ordered} aria-pressed={fmt.ordered} title={t('WysiwygEditor.ordered')} aria-label={t('WysiwygEditor.ordered')} onclick={() => run('ordered')}><ListOrderedIcon size={16} aria-hidden="true" /></button>
			<button type="button" class:on={fmt.quote} aria-pressed={fmt.quote} title={t('WysiwygEditor.quote')} aria-label={t('WysiwygEditor.quote')} onclick={() => run('quote')}><QuoteIcon size={16} aria-hidden="true" /></button>
			<button type="button" class:on={fmt.codeblock} aria-pressed={fmt.codeblock} title={t('WysiwygEditor.codeBlock')} aria-label={t('WysiwygEditor.codeBlock')} onclick={() => run('codeblock')}><SquareCodeIcon size={16} aria-hidden="true" /></button>
		</div>
		<div class="grp">
			<button type="button" class:on={fmt.link} aria-pressed={fmt.link} title={t('WysiwygEditor.link')} aria-label={t('WysiwygEditor.link')} onclick={openLink}><LinkIcon size={16} aria-hidden="true" /></button>
			<button type="button" title={t('WysiwygEditor.image')} aria-label={t('WysiwygEditor.image')} onclick={openImage}><ImageIcon size={16} aria-hidden="true" /></button>
			<button type="button" title={t('WysiwygEditor.table')} aria-label={t('WysiwygEditor.table')} onclick={() => run('table')}><TableIcon size={16} aria-hidden="true" /></button>
			<button type="button" disabled={!fmt.table} title={t('WysiwygEditor.rowAfter')} aria-label={t('WysiwygEditor.rowAfter')} onclick={() => run('rowAfter')}><TableRowsSplitIcon size={16} aria-hidden="true" /></button>
			<button type="button" disabled={!fmt.table} title={t('WysiwygEditor.colAfter')} aria-label={t('WysiwygEditor.colAfter')} onclick={() => run('colAfter')}><TableColumnsSplitIcon size={16} aria-hidden="true" /></button>
		</div>
		<div class="grp">
			<button type="button" title={t('WysiwygEditor.formulaInline')} aria-label={t('WysiwygEditor.formulaInline')} onclick={() => insertFormula('inline')}><SigmaIcon size={16} aria-hidden="true" /></button>
			<button type="button" title={t('WysiwygEditor.formulaBlock')} aria-label={t('WysiwygEditor.formulaBlock')} onclick={() => insertFormula('block')}><SquareSigmaIcon size={16} aria-hidden="true" /></button>
		</div>
	</div>

	{#if linkOpen}
		<form class="bar" onsubmit={(e) => { e.preventDefault(); applyLink(); }}>
			<label for="vc-link-href">{t('WysiwygEditor.linkUrl')}</label>
			<!-- svelte-ignore a11y_autofocus -->
			<input id="vc-link-href" type="text" bind:value={linkHref} placeholder="https://" autofocus onkeydown={(e) => e.key === 'Escape' && ((linkOpen = false), editor?.focus())} />
			<button type="submit" class="vc-btn primary">{t('WysiwygEditor.linkApply')}</button>
			<button type="button" class="vc-btn ghost" onclick={() => { linkOpen = false; editor?.focus(); }}>{t('WysiwygEditor.cancel')}</button>
		</form>
	{/if}
	{#if imageOpen}
		<form class="bar wrap" onsubmit={(e) => { e.preventDefault(); applyImage(); }}>
			<label for="vc-img-src">{t('WysiwygEditor.imageSrc')}</label>
			<!-- svelte-ignore a11y_autofocus -->
			<input id="vc-img-src" type="text" bind:value={imageSrc} autofocus onkeydown={(e) => e.key === 'Escape' && ((imageOpen = false), editor?.focus())} />
			<label for="vc-img-alt">{t('WysiwygEditor.imageAlt')}</label>
			<input id="vc-img-alt" type="text" bind:value={imageAlt} />
			<button type="submit" class="vc-btn primary">{t('WysiwygEditor.imageApply')}</button>
			<button type="button" class="vc-btn ghost" onclick={() => { imageOpen = false; editor?.focus(); }}>{t('WysiwygEditor.cancel')}</button>
			<p class="hint">{t('WysiwygEditor.imageNote')}</p>
		</form>
	{/if}

	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="scroller" onkeydown={onKeydown}>
		{#if failed}<p class="note">{t('LibraryViewPage.editorLoadFailed')}</p>{/if}
		{#if !ready && !failed}<p class="note">{t('WysiwygEditor.loading')}</p>{/if}
		<div class="host markdown-body" bind:this={host} class:hidden={!ready}></div>
	</div>

	{#if math}
		<MathPopover latex={math.latex} rect={math.rect} onapply={applyMath} oncancel={cancelMath} />
	{/if}
</div>

<style>
	.vc-visual {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		border-radius: var(--radius-lg);
		border: 1px solid var(--separator-strong);
		background: var(--bg-elevated);
		overflow: hidden;
	}

	.tb {
		display: flex;
		flex-wrap: wrap;
		gap: 0.15rem 0.6rem;
		padding: 0.35rem 0.5rem;
		border-bottom: 1px solid var(--separator);
		background: var(--bg-grouped, var(--bg-elevated));
	}

	.grp {
		display: inline-flex;
		gap: 0.1rem;
	}

	.grp + .grp {
		padding-inline-start: 0.6rem;
		border-inline-start: 1px solid var(--separator);
	}

	.tb button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 2rem;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--label-secondary);
		cursor: pointer;
		transition: background var(--motion-fast, 120ms) ease, color var(--motion-fast, 120ms) ease;
	}

	.tb button:hover:not(:disabled) {
		background: var(--fill-hover);
		color: var(--label);
	}

	.tb button.on {
		background: var(--accent-soft);
		color: var(--accent-text, var(--accent));
	}

	.tb button:disabled {
		opacity: 0.4;
		cursor: default;
	}

	.tb button:focus-visible,
	.bar input:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 1px;
	}

	.bar {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.45rem 0.6rem;
		border-bottom: 1px solid var(--separator);
		font: var(--text-footnote);
		color: var(--label-secondary);
	}

	.bar.wrap {
		flex-wrap: wrap;
	}

	.bar input {
		flex: 1;
		min-width: 8rem;
		padding: 0.3rem 0.5rem;
		border-radius: var(--radius-sm);
		border: 1px solid var(--separator-strong);
		background: var(--fill-control);
		color: var(--label);
		font: var(--text-footnote);
	}

	.hint {
		flex-basis: 100%;
		margin: 0;
		color: var(--label-tertiary);
	}

	.scroller {
		flex: 1;
		min-height: 0;
		overflow: auto;
		padding: 0.75rem 1.25rem 2rem;
	}

	.host.hidden {
		visibility: hidden;
		height: 0;
		overflow: hidden;
	}

	.note {
		margin: 0;
		padding: 0.5rem 0;
		font: var(--text-footnote);
		color: var(--label-secondary);
	}

	/* ---- content: the viewer's own .markdown-body rules do most of the work ---- */
	.host :global(.ProseMirror) {
		outline: none;
		min-height: 12rem;
		line-height: 1.7;
	}

	.host :global(.ProseMirror:focus-visible) {
		outline: 2px solid var(--focus-ring);
		outline-offset: 4px;
		border-radius: var(--radius-sm);
	}

	.host :global(.ProseMirror img) {
		max-width: 100%;
	}

	.host :global(.ProseMirror pre:not(.vc-raw-block)) {
		padding: 0.75rem 1rem;
		border-radius: var(--radius-md);
		background: var(--fill-hover);
		overflow: auto;
		font-family: var(--font-mono);
		font-size: 0.9em;
	}

	.host :global(.ProseMirror code:not(pre code)) {
		padding: 0.1em 0.35em;
		border-radius: var(--radius-sm);
		background: var(--fill-hover);
		font-family: var(--font-mono);
		font-size: 0.9em;
	}

	/* A formula is clickable: show it, and keep it keyboard reachable. */
	.host :global([data-type='math_inline']),
	.host :global([data-type='math_block']) {
		cursor: pointer;
		border-radius: var(--radius-sm);
	}

	.host :global([data-type='math_inline']) {
		display: inline-block;
	}

	.host :global([data-type='math_inline']:hover),
	.host :global([data-type='math_block']:hover) {
		background: var(--fill-hover);
	}

	.host :global(.ProseMirror-selectednode) {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}

	/* Locked block: shown as source text, editable as plain text. */
	.host :global(pre.vc-raw-block) {
		margin: 0.75rem 0;
		padding: 0.6rem 0.9rem;
		border-radius: var(--radius-md);
		border: 1px dashed var(--separator-strong);
		border-inline-start: 3px solid var(--warning);
		background: var(--fill-hover);
		font-family: var(--font-mono);
		font-size: 0.85em;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		color: var(--label-secondary);
	}

	.host :global(pre.vc-raw-block code) {
		font: inherit;
		background: none;
		padding: 0;
	}

	.host :global(.tableWrapper) {
		overflow-x: auto;
	}

	.host :global(.selectedCell) {
		background: var(--accent-soft);
	}
</style>
