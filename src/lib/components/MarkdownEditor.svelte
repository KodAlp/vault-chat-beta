<script lang="ts">
	/**
	 * CodeMirror 6 Markdown editor. Imported ONLY via dynamic import() from the
	 * library viewer when the user enters edit mode, so CodeMirror stays out of
	 * the viewer's own bundle.
	 *
	 * Props are deliberately minimal: `value` is the source of truth from the
	 * parent (re-synced into the editor when it changes from outside, e.g. after
	 * a reload), `onchange` reports every user edit. Everything is themed
	 * through the app's CSS variables so it follows all five themes without a
	 * per-theme CodeMirror theme object.
	 */
	import { onMount } from 'svelte';
	import { EditorState } from '@codemirror/state';
	import { EditorView } from '@codemirror/view';
	import { basicSetup } from 'codemirror';
	import { markdown } from '@codemirror/lang-markdown';
	import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
	import { tags as t } from '@lezer/highlight';
	import { detectLineSeparator } from '$lib/line-separator';

	let { value, onchange }: { value: string; onchange: (next: string) => void } = $props();

	let host: HTMLDivElement;
	let view: EditorView | undefined;

	// basicSetup bundles line numbers, history (undo/redo), the search keymap,
	// bracket handling and the default keymap.
	const theme = EditorView.theme({
		'&': {
			height: '100%',
			color: 'var(--label)',
			backgroundColor: 'var(--bg-elevated)',
			fontFamily: 'var(--font-mono)',
			fontSize: '14px'
		},
		'&.cm-focused': { outline: '2px solid var(--focus-ring)', outlineOffset: '-2px' },
		'.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6', overflow: 'auto' },
		'.cm-content': { caretColor: 'var(--accent)', padding: '8px 0' },
		'.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
		'&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
			backgroundColor: 'var(--accent-soft)'
		},
		'.cm-activeLine': { backgroundColor: 'var(--fill-hover)' },
		'.cm-gutters': {
			backgroundColor: 'var(--bg-elevated)',
			color: 'var(--label-tertiary)',
			border: 'none',
			borderRight: '1px solid var(--separator)'
		},
		'.cm-activeLineGutter': { backgroundColor: 'var(--fill-hover)', color: 'var(--label-secondary)' },
		'.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
			backgroundColor: 'var(--accent-soft)',
			outline: '1px solid var(--separator-strong)'
		},
		'.cm-searchMatch': { backgroundColor: 'var(--accent-soft)', outline: '1px solid var(--accent)' },
		'.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--accent)', color: 'var(--on-accent)' },
		'.cm-panels': {
			backgroundColor: 'var(--bg-grouped)',
			color: 'var(--label)',
			borderColor: 'var(--separator)'
		},
		'.cm-panels input, .cm-panels button': {
			font: 'var(--text-footnote)',
			color: 'var(--label)',
			backgroundColor: 'var(--fill-control)',
			border: '1px solid var(--separator-strong)',
			borderRadius: 'var(--radius-sm)'
		},
		'.cm-panels label': { font: 'var(--text-footnote)', color: 'var(--label-secondary)' },
		'.cm-tooltip': {
			backgroundColor: 'var(--bg-elevated)',
			color: 'var(--label)',
			border: '1px solid var(--separator-strong)'
		}
	});

	// Own highlight style instead of CodeMirror's default (whose fixed colours
	// are unreadable on the dark/forest themes).
	const highlight = HighlightStyle.define([
		{ tag: [t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6], fontWeight: '700', color: 'var(--label)' },
		{ tag: t.strong, fontWeight: '700' },
		{ tag: t.emphasis, fontStyle: 'italic' },
		{ tag: t.strikethrough, textDecoration: 'line-through' },
		{ tag: [t.link, t.url], color: 'var(--accent-text)' },
		{ tag: t.quote, color: 'var(--label-secondary)' },
		{ tag: t.monospace, color: 'var(--label-secondary)' },
		{ tag: [t.processingInstruction, t.meta, t.contentSeparator], color: 'var(--label-tertiary)' }
	]);

	// The line separator is fixed per EditorState (a facet), so it is detected
	// from the loaded text and the state is rebuilt when a reload brings in a
	// file with a different one. Reading back via sliceDoc (joins with the
	// state's own separator) instead of doc.toString() (always LF) is what
	// keeps CRLF files CRLF on save.
	function makeState(doc: string): EditorState {
		const sep = detectLineSeparator(doc);
		return EditorState.create({
			doc,
			extensions: [
				...(sep ? [EditorState.lineSeparator.of(sep)] : []),
				basicSetup,
				markdown(),
				EditorView.lineWrapping,
				theme,
				syntaxHighlighting(highlight),
				EditorView.updateListener.of((u) => {
					if (u.docChanged) onchange(u.state.sliceDoc(0));
				})
			]
		});
	}

	onMount(() => {
		view = new EditorView({ parent: host, state: makeState(value) });
		return () => view?.destroy();
	});

	// Parent replaced the text (reload from disk / restore): push it in, but
	// never when it already matches — that would reset the cursor on every
	// keystroke echo.
	$effect(() => {
		const next = value;
		if (!view || next === view.state.sliceDoc(0)) return;
		if (detectLineSeparator(next) !== detectLineSeparator(view.state.sliceDoc(0))) {
			view.setState(makeState(next));
		} else {
			view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } });
		}
	});
</script>

<div class="md-editor" bind:this={host}></div>

<style>
	.md-editor {
		height: 100%;
		min-height: 0;
		border-radius: var(--radius-lg);
		overflow: hidden;
		/* A real border, not an inset shadow: CodeMirror's opaque background
		   would paint over the shadow. */
		border: 1px solid var(--separator-strong);
	}
</style>
