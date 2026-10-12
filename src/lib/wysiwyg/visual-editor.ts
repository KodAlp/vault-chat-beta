/**
 * Milkdown 7 wiring for the WYSIWYG note editor (client only; imported lazily
 * by WysiwygEditor.svelte, never from the viewer bundle).
 *
 * The editor is NOT used to serialize the whole note. See note-blocks.ts: the
 * note is cut into blocks, each block is parsed on its own, and only blocks
 * the user changed are serialized again. Blocks whose re-serialization would
 * change the viewer output (block-safety.ts) become locked `raw_block` nodes
 * that are edited as plain text in place.
 *
 * Patches on top of stock Milkdown, each found by measuring this app's notes:
 *  - null image/link titles: remark gives `title: null`, the schema requires a
 *    string, and the parser then silently DROPS the image;
 *  - math (plugin-math) with KaTeX throwOnError:false, otherwise one unknown
 *    macro makes the whole editor fail to construct;
 *  - `\( \)` / `\[ \]` are math in the viewer (markdown.ts), so they are
 *    rewritten to `$ $` / `$$ $$` before parsing;
 *  - the "preserve empty line" remark plugin is removed: it makes the
 *    serializer emit a literal `<br />` that the viewer (html:false) prints as text;
 *  - relative image links are shown through the attachment route, via a node
 *    view (rewriting <img src> in the DOM would be read back into the model).
 */
import { Editor, rootCtx, editorViewCtx, parserCtx, serializerCtx, schemaCtx, remarkStringifyOptionsCtx } from '@milkdown/kit/core';
import { commonmark, remarkPreserveEmptyLinePlugin, imageSchema, toggleStrongCommand, toggleEmphasisCommand, toggleInlineCodeCommand, wrapInHeadingCommand, turnIntoTextCommand, wrapInBulletListCommand, wrapInOrderedListCommand, wrapInBlockquoteCommand, toggleLinkCommand, createCodeBlockCommand, insertImageCommand } from '@milkdown/kit/preset/commonmark';
import { gfm, toggleStrikethroughCommand, insertTableCommand, addRowAfterCommand, addColAfterCommand } from '@milkdown/kit/preset/gfm';
import { history, undoCommand, redoCommand } from '@milkdown/kit/plugin/history';
import { math, katexOptionsCtx, mathBlockSchema } from '@milkdown/plugin-math';
import katex from 'katex';
import { $remark, $prose, $nodeSchema, $view, callCommand } from '@milkdown/kit/utils';
import { Plugin } from '@milkdown/kit/prose/state';
import type { EditorState } from '@milkdown/kit/prose/state';
import type { Node as PmNode } from '@milkdown/kit/prose/model';
import type { SerializerState } from '@milkdown/kit/transformer';
import { visit } from 'unist-util-visit';
import { splitNote, assemble, alignBlocks, toLf, type NoteModel, type OutItem } from './note-blocks';
import { isRoundTripSafe, mathSpansAgree, MAX_UNSAFE_BLOCKS } from './block-safety';
import { protectCode, restoreCode, normalizeMathDelimiters } from '../markdown-prepare';
import { ABSOLUTE_SRC_RE, resolveRelativeLibraryPath } from '../attachment-link';

export type ToolbarCommand =
	| 'bold'
	| 'italic'
	| 'strike'
	| 'code'
	| 'h1'
	| 'h2'
	| 'h3'
	| 'paragraph'
	| 'bullet'
	| 'ordered'
	| 'quote'
	| 'codeblock'
	| 'table'
	| 'rowAfter'
	| 'colAfter'
	| 'undo'
	| 'redo';

export interface FormatState {
	bold: boolean;
	italic: boolean;
	strike: boolean;
	code: boolean;
	link: boolean;
	heading: 0 | 1 | 2 | 3 | 4 | 5 | 6;
	bullet: boolean;
	ordered: boolean;
	quote: boolean;
	codeblock: boolean;
	table: boolean;
	rawBlock: boolean;
}

export interface MathTarget {
	kind: 'inline' | 'block';
	pos: number;
	latex: string;
	/** Viewport rectangle of the formula, used to place the popover. */
	rect: DOMRect;
}

export interface VisualEditorOptions {
	host: HTMLElement;
	vaultId: string;
	currentPath: string;
	/** Image files pasted or dropped into the editor (the owner uploads them and calls insertImage). */
	onImageFiles?: (files: File[]) => void;
	/** Tooltip on locked raw blocks (already localized). */
	rawBlockTitle: string;
	onChange: (raw: string) => void;
	onFormat: (state: FormatState) => void;
	onMath: (target: MathTarget) => void;
}

export type LoadResult = { ok: true; blocks: number; locked: number } | { ok: false; reason: 'too-many-unsafe'; locked: number };

// remark yields title:null for untitled images/links, the Milkdown schema validates 'string'.
const fixNullTitle = $remark('vc-fix-null-title', () => () => (tree: unknown) => {
	visit(tree as never, ['image', 'link', 'definition'], (n: { title?: string | null }) => {
		if (n.title == null) n.title = '';
	});
});

const rawBlockSchema = $nodeSchema('raw_block', () => ({
	group: 'block',
	content: 'text*',
	marks: '',
	code: true,
	defining: true,
	isolating: true,
	parseDOM: [{ tag: 'pre[data-raw-block]', preserveWhitespace: 'full' as const }],
	toDOM: () => ['pre', { class: 'vc-raw-block', 'data-raw-block': '' }, ['code', 0]],
	// Never produced by the markdown parser; blocks are built by load().
	parseMarkdown: { match: () => false, runner: () => {} },
	toMarkdown: {
		match: (node: PmNode) => node.type.name === 'raw_block',
		runner: (state: SerializerState, node: PmNode) => {
			state.addNode('html', undefined, node.textContent);
		}
	}
}));

function mathNodeAt(state: EditorState, pos: number): { node: PmNode; pos: number; kind: 'inline' | 'block' } | null {
	for (const p of [pos, pos - 1, pos + 1]) {
		if (p < 0 || p > state.doc.content.size) continue;
		const node = state.doc.nodeAt(p);
		if (node?.type.name === 'math_inline') return { node, pos: p, kind: 'inline' };
		if (node?.type.name === 'math_block') return { node, pos: p, kind: 'block' };
	}
	return null;
}

function formatOf(state: EditorState): FormatState {
	const { $from, from, to, empty } = state.selection;
	const marks = (name: string) => {
		const type = state.schema.marks[name];
		if (!type) return false;
		return empty ? !!type.isInSet(state.storedMarks ?? $from.marks()) : state.doc.rangeHasMark(from, to, type);
	};
	const inside = (name: string) => {
		for (let d = $from.depth; d > 0; d--) if ($from.node(d).type.name === name) return true;
		return false;
	};
	return {
		bold: marks('strong'),
		italic: marks('emphasis'),
		strike: marks('strike_through'),
		code: marks('inlineCode'),
		link: marks('link'),
		heading: $from.parent.type.name === 'heading' ? (($from.parent.attrs.level as FormatState['heading']) ?? 0) : 0,
		bullet: inside('bullet_list'),
		ordered: inside('ordered_list'),
		quote: inside('blockquote'),
		codeblock: $from.parent.type.name === 'code_block',
		table: inside('table'),
		rawBlock: $from.parent.type.name === 'raw_block'
	};
}

/** `\( \)` / `\[ \]` -> `$ $` / `$$ $$` outside code, exactly like the viewer does before rendering. */
function toParseText(lf: string): string {
	const { text, blocks } = protectCode(lf);
	return restoreCode(normalizeMathDelimiters(text), blocks);
}

/** Every formula in a parsed block, in document order. */
function mathOf(node: PmNode): string[] {
	const out: string[] = [];
	node.descendants((n) => {
		if (n.type.name === 'math_inline') out.push(n.textContent);
		else if (n.type.name === 'math_block') out.push(String(n.attrs.value ?? ''));
		return true;
	});
	if (node.type.name === 'math_block') out.push(String(node.attrs.value ?? ''));
	return out;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

export async function createVisualEditor(opts: VisualEditorOptions) {
	let model: NoteModel = splitNote('');
	let origKeys: string[] = [];
	let loading = true;
	let changeTimer: ReturnType<typeof setTimeout> | undefined;
	const keyCache = new WeakMap<PmNode, string>();
	const keyOf = (n: PmNode) => {
		let k = keyCache.get(n);
		if (k === undefined) keyCache.set(n, (k = JSON.stringify(n.toJSON())));
		return k;
	};

	const imageView = $view(imageSchema.node, () => (node: PmNode) => {
		const img = document.createElement('img');
		const apply = (n: PmNode) => {
			const src = String(n.attrs.src ?? '');
			let shown = src;
			if (src && !ABSOLUTE_SRC_RE.test(src) && opts.vaultId) {
				try {
					const resolved = resolveRelativeLibraryPath(opts.currentPath, decodeURI(src));
					shown = `/api/library/attachment?${new URLSearchParams({ path: resolved, vault: opts.vaultId }).toString()}`;
				} catch {
					shown = src;
				}
			}
			img.src = shown;
			img.alt = String(n.attrs.alt ?? '');
			img.title = String(n.attrs.title ?? '');
		};
		apply(node);
		return {
			dom: img,
			update: (n: PmNode) => {
				if (n.type !== node.type) return false;
				apply(n);
				return true;
			}
		};
	});

	// plugin-math renders block formulas without displayMode, so 	ag, aligned, cases... fail.
	// The viewer renders them in display mode; so does this view.
	const mathBlockView = $view(mathBlockSchema.node, () => (node: PmNode) => {
		const dom = document.createElement('div');
		dom.dataset.type = 'math_block';
		dom.contentEditable = 'false';
		const paint = (n: PmNode) => {
			const latex = String(n.attrs.value ?? '');
			dom.dataset.value = latex;
			try {
				katex.render(latex, dom, { throwOnError: false, displayMode: true });
			} catch {
				dom.textContent = latex;
			}
		};
		paint(node);
		return {
			dom,
			update: (n: PmNode) => {
				if (n.type !== node.type) return false;
				paint(n);
				return true;
			}
		};
	});

	const rawView = $view(rawBlockSchema.node, () => () => {
		const dom = document.createElement('pre');
		dom.className = 'vc-raw-block';
		dom.dataset.rawBlock = '';
		dom.title = opts.rawBlockTitle;
		const contentDOM = document.createElement('code');
		dom.append(contentDOM);
		return { dom, contentDOM };
	});

	let prevDoc: PmNode | null = null;
	const watcher = $prose(
		() =>
			new Plugin({
				view: () => ({
					update: (view, prev) => {
						opts.onFormat(formatOf(view.state));
						if (loading || view.state.doc === prev.doc) return;
						clearTimeout(changeTimer);
						// Debounced: assembling touches every block key; no need on each keystroke.
						changeTimer = setTimeout(() => opts.onChange(getMarkdown()), 150);
					}
				})
			})
	);

	const preset = commonmark.filter((p) => p !== remarkPreserveEmptyLinePlugin.plugin && p !== remarkPreserveEmptyLinePlugin.options);

	const ed = await Editor.make()
		.config((ctx) => {
			ctx.set(rootCtx, opts.host);
			ctx.set(katexOptionsCtx.key, { throwOnError: false });
			// Markers the library already uses; only affects blocks the user edits.
			ctx.update(remarkStringifyOptionsCtx, (o) => ({ ...o, bullet: '-' as const, emphasis: '*' as const, strong: '*' as const, fence: '`' as const, rule: '-' as const, listItemIndent: 'one' as const }));
		})
		.use(preset)
		.use(gfm)
		.use(history)
		.use(math)
		.use(fixNullTitle)
		.use(rawBlockSchema)
		.use(imageView)
		.use(mathBlockView)
		.use(rawView)
		.use(watcher)
		.create();

	void prevDoc;

	function view() {
		return ed.action((ctx) => ctx.get(editorViewCtx));
	}

	function serializeNode(node: PmNode): string {
		return ed.action((ctx) => {
			const schema = ctx.get(schemaCtx);
			const text = ctx.get(serializerCtx)(schema.node('doc', null, [node]));
			return text.replace(/\n+$/, '');
		});
	}

	function getMarkdown(): string {
		const doc = view().state.doc;
		const cur: PmNode[] = [];
		doc.forEach((n) => cur.push(n));
		const al = alignBlocks(origKeys, cur.map(keyOf));
		const items: OutItem[] = [];
		cur.forEach((node, i) => {
			const a = al[i];
			if (a.kind === 'same' && a.orig !== null) {
				items.push({ keep: a.orig });
				return;
			}
			const text = node.type.name === 'raw_block' ? node.textContent : serializeNode(node);
			if (text.trim() === '') return; // emptied (or placeholder) paragraph: drop the block
			items.push({ text, inheritGap: a.kind === 'edited' ? a.orig : null });
		});
		return assemble(model, items);
	}

	/** Parse every block alone, keep it visual only if the gate proves it safe. */
	async function load(raw: string): Promise<LoadResult> {
		loading = true;
		clearTimeout(changeTimer);
		model = splitNote(raw);
		const nodes: PmNode[] = [];
		let locked = 0;
		const parts = model.parts;
		const CHUNK = 150;
		for (let start = 0; start < parts.length; start += CHUNK) {
			ed.action((ctx) => {
				const parser = ctx.get(parserCtx);
				const ser = ctx.get(serializerCtx);
				const schema = ctx.get(schemaCtx);
				const rawType = schema.nodes.raw_block;
				for (const part of parts.slice(start, start + CHUNK)) {
					const lf = toLf(part.src);
					let node: PmNode | null = null;
					try {
						const doc = parser(toParseText(lf));
						if (doc.childCount === 1) {
							const out = ser(schema.node('doc', null, [doc.child(0)])).replace(/\n+$/, '');
							if (isRoundTripSafe(lf, out) && mathSpansAgree(lf, mathOf(doc.child(0)))) node = doc.child(0);
						}
					} catch {
						node = null;
					}
					if (!node) {
						locked++;
						node = rawType.create(null, lf ? schema.text(lf) : null);
					}
					nodes.push(node);
				}
			});
			if (locked > MAX_UNSAFE_BLOCKS) {
				loading = false;
				return { ok: false, reason: 'too-many-unsafe', locked };
			}
			await tick();
		}
		const v = view();
		ed.action((ctx) => {
			const schema = ctx.get(schemaCtx);
			const content = nodes.length ? nodes : [schema.nodes.paragraph.create()];
			const tr = v.state.tr.replaceWith(0, v.state.doc.content.size, content).setMeta('addToHistory', false);
			v.dispatch(tr);
		});
		// Keys come from the nodes as they sit in the document: appendTransaction plugins
		// (heading ids, list order sync) have already normalized them, and a key taken
		// from the freshly parsed node would differ and make every heading look edited.
		origKeys = [];
		// (a note with no blocks gets a placeholder paragraph that must not map to any part)
		if (nodes.length) v.state.doc.forEach((n) => origKeys.push(keyOf(n)));
		loading = false;
		opts.onFormat(formatOf(v.state));
		return { ok: true, blocks: nodes.length, locked };
	}

	function exec(cmd: ToolbarCommand) {
		const run = <T>(cmd: { key: unknown }, payload?: T) => ed.action(callCommand(cmd.key as never, payload as never));
		switch (cmd) {
			case 'bold': run(toggleStrongCommand); break;
			case 'italic': run(toggleEmphasisCommand); break;
			case 'strike': run(toggleStrikethroughCommand); break;
			case 'code': run(toggleInlineCodeCommand); break;
			case 'h1': run(wrapInHeadingCommand, 1); break;
			case 'h2': run(wrapInHeadingCommand, 2); break;
			case 'h3': run(wrapInHeadingCommand, 3); break;
			case 'paragraph': run(turnIntoTextCommand); break;
			case 'bullet': run(wrapInBulletListCommand); break;
			case 'ordered': run(wrapInOrderedListCommand); break;
			case 'quote': run(wrapInBlockquoteCommand); break;
			case 'codeblock': run(createCodeBlockCommand); break;
			case 'table': run(insertTableCommand, { row: 3, col: 3 }); break;
			case 'rowAfter': run(addRowAfterCommand); break;
			case 'colAfter': run(addColAfterCommand); break;
			case 'undo': run(undoCommand); break;
			case 'redo': run(redoCommand); break;
		}
		view().focus();
	}

	function setLink(href: string) {
		ed.action(callCommand(toggleLinkCommand.key, { href }));
		view().focus();
	}

	function removeLink() {
		ed.action(callCommand(toggleLinkCommand.key));
		view().focus();
	}

	function insertImage(src: string, alt: string) {
		ed.action(callCommand(insertImageCommand.key, { src, alt, title: '' }));
		view().focus();
	}

	/** Insert a formula at the cursor and return where it landed (for the popover). */
	function insertMath(kind: 'inline' | 'block'): MathTarget | null {
		const v = view();
		const schema = v.state.schema;
		const { from } = v.state.selection;
		const tr = v.state.tr;
		if (kind === 'inline') {
			tr.replaceSelectionWith(schema.nodes.math_inline.create(null, schema.text('x')));
		} else {
			tr.replaceSelectionWith(schema.nodes.math_block.create({ value: 'x' }));
		}
		v.dispatch(tr);
		const found = mathNodeAt(v.state, kind === 'inline' ? from : tr.selection.from - 1) ?? mathNodeAt(v.state, from);
		return found ? targetFor(found.pos, found.kind, found.node) : null;
	}

	function targetFor(pos: number, kind: 'inline' | 'block', node: PmNode): MathTarget {
		const v = view();
		const dom = v.nodeDOM(pos) as HTMLElement | null;
		const rect = dom?.getBoundingClientRect?.() ?? v.dom.getBoundingClientRect();
		return { kind, pos, latex: kind === 'inline' ? node.textContent : String(node.attrs.value ?? ''), rect };
	}

	function setMath(pos: number, latex: string) {
		const v = view();
		const found = mathNodeAt(v.state, pos);
		if (!found) return;
		const tr = v.state.tr;
		if (found.kind === 'inline') {
			if (latex.trim() === '') tr.delete(found.pos, found.pos + found.node.nodeSize);
			else tr.replaceWith(found.pos + 1, found.pos + 1 + found.node.content.size, v.state.schema.text(latex));
		} else if (latex.trim() === '') tr.delete(found.pos, found.pos + found.node.nodeSize);
		else tr.setNodeMarkup(found.pos, undefined, { ...found.node.attrs, value: latex });
		v.dispatch(tr);
		v.focus();
	}

	function onHostClick(e: MouseEvent) {
		const el = (e.target as HTMLElement | null)?.closest?.('[data-type="math_inline"], [data-type="math_block"]');
		if (!el) return;
		const v = view();
		const found = mathNodeAt(v.state, v.posAtDOM(el, 0));
		if (found) opts.onMath(targetFor(found.pos, found.kind, found.node));
	}
	function onHostKeydown(e: KeyboardEvent) {
		if (e.key !== 'Enter' || e.ctrlKey || e.metaKey || e.shiftKey) return;
		const sel = view().state.selection as { node?: PmNode; from: number };
		if (sel.node && (sel.node.type.name === 'math_inline' || sel.node.type.name === 'math_block')) {
			e.preventDefault();
			opts.onMath(targetFor(sel.from, sel.node.type.name === 'math_inline' ? 'inline' : 'block', sel.node));
		}
	}
	// Capture phase so ProseMirror's own paste/drop handling does not also run for an image file.
	const imageFilesOf = (dt: DataTransfer | null) => Array.from(dt?.files ?? []).filter((f) => f.type.startsWith('image/'));
	function onHostPaste(e: ClipboardEvent) {
		const files = imageFilesOf(e.clipboardData);
		if (!files.length || !opts.onImageFiles) return;
		e.preventDefault();
		e.stopPropagation();
		opts.onImageFiles(files);
	}
	function onHostDrop(e: DragEvent) {
		const files = imageFilesOf(e.dataTransfer);
		if (!files.length || !opts.onImageFiles) return;
		e.preventDefault();
		e.stopPropagation();
		opts.onImageFiles(files);
	}
	opts.host.addEventListener('click', onHostClick);
	opts.host.addEventListener('keydown', onHostKeydown);
	opts.host.addEventListener('paste', onHostPaste, true);
	opts.host.addEventListener('drop', onHostDrop, true);

	return {
		load,
		getMarkdown,
		exec,
		setLink,
		removeLink,
		insertImage,
		insertMath,
		setMath,
		focus: () => view().focus(),
		destroy() {
			clearTimeout(changeTimer);
			opts.host.removeEventListener('click', onHostClick);
			opts.host.removeEventListener('keydown', onHostKeydown);
			opts.host.removeEventListener('paste', onHostPaste, true);
			opts.host.removeEventListener('drop', onHostDrop, true);
			void ed.destroy();
		}
	};
}

export type VisualEditor = Awaited<ReturnType<typeof createVisualEditor>>;
