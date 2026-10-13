/**
 * Vendored from @milkdown/plugin-math@7.5.9 (deprecated on npm, "no longer supported";
 * Milkdown's kit has no math plugin and Crepe's latex feature is a separate Vue/CodeMirror
 * implementation, so a swap would change the node schema and behavior).
 *
 * The MIT License (MIT)
 * Copyright (c) 2020-present Mirone
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * Local changes: imports go through @milkdown/kit, the meta package name is ours,
 * and the plugin carries no dependency on the deprecated package.
 */
import { $ctx, $inputRule, $nodeSchema, $remark } from '@milkdown/kit/utils';
import type { KatexOptions } from 'katex';
import katex from 'katex';
import remarkMath from 'remark-math';
import type { Meta, MilkdownPlugin } from '@milkdown/kit/ctx';
import { Fragment } from '@milkdown/kit/prose/model';
import { InputRule } from '@milkdown/kit/prose/inputrules';
import { expectDomTypeError } from '@milkdown/kit/exception';
import { nodeRule } from '@milkdown/kit/prose';

function withMeta<T extends MilkdownPlugin>(plugin: T, meta: Partial<Meta> & Pick<Meta, 'displayName'>): T {
	Object.assign(plugin, { meta: { package: 'vault-chat/milkdown-math', ...meta } });
	return plugin;
}

/** Wraps remark-math. */
export const remarkMathPlugin = $remark<'remarkMath', undefined>('remarkMath', () => remarkMath);
withMeta(remarkMathPlugin.plugin, { displayName: 'Remark<remarkMath>' });
withMeta(remarkMathPlugin.options, { displayName: 'RemarkConfig<remarkMath>' });

const mathInlineId = 'math_inline';

/** KaTeX options (https://katex.org/docs/options.html). */
export const katexOptionsCtx = $ctx<KatexOptions, 'katexOptions'>({}, 'katexOptions');
withMeta(katexOptionsCtx, { displayName: 'Ctx<katexOptions>' });

/** Inline math node: `$a^2 + b^2 = c^2$`. */
export const mathInlineSchema = $nodeSchema('math_inline', (ctx) => ({
	group: 'inline',
	content: 'text*',
	inline: true,
	atom: true,
	parseDOM: [
		{
			tag: `span[data-type="${mathInlineId}"]`,
			getContent: (dom, schema) => {
				if (!(dom instanceof HTMLElement)) throw expectDomTypeError(dom);
				return Fragment.from(schema.text(dom.dataset.value ?? ''));
			}
		}
	],
	toDOM: (node) => {
		const code: string = node.textContent;
		const dom = document.createElement('span');
		dom.dataset.type = mathInlineId;
		dom.dataset.value = code;
		katex.render(code, dom, ctx.get(katexOptionsCtx.key));
		return dom;
	},
	parseMarkdown: {
		match: (node) => node.type === 'inlineMath',
		runner: (state, node, type) => {
			state.openNode(type).addText(node.value as string).closeNode();
		}
	},
	toMarkdown: {
		match: (node) => node.type.name === mathInlineId,
		runner: (state, node) => {
			state.addNode('inlineMath', undefined, node.textContent);
		}
	}
}));
withMeta(mathInlineSchema.ctx, { displayName: 'NodeSchemaCtx<mathInline>' });
withMeta(mathInlineSchema.node, { displayName: 'NodeSchema<mathInline>' });

/** Typing `$E=MC^2$` creates an inline math node. */
export const mathInlineInputRule = $inputRule((ctx) =>
	nodeRule(/(?:\$)([^$]+)(?:\$)$/, mathInlineSchema.type(ctx), {
		beforeDispatch: ({ tr, match, start }) => {
			tr.insertText(match[1] ?? '', start + 1);
		}
	})
);
withMeta(mathInlineInputRule, { displayName: 'InputRule<mathInline>' });

const mathBlockId = 'math_block';

/** Block math node: `$$\n...\n$$`. */
export const mathBlockSchema = $nodeSchema('math_block', (ctx) => ({
	content: 'text*',
	group: 'block',
	marks: '',
	defining: true,
	atom: true,
	isolating: true,
	attrs: { value: { default: '' } },
	parseDOM: [
		{
			tag: `div[data-type="${mathBlockId}"]`,
			preserveWhitespace: 'full',
			getAttrs: (dom) => ({ value: (dom as HTMLElement).dataset.value ?? '' })
		}
	],
	toDOM: (node) => {
		const code = node.attrs.value;
		const dom = document.createElement('div');
		dom.dataset.type = mathBlockId;
		dom.dataset.value = code;
		katex.render(code, dom, ctx.get(katexOptionsCtx.key));
		return dom;
	},
	parseMarkdown: {
		match: ({ type }) => type === 'math',
		runner: (state, node, type) => {
			state.addNode(type, { value: node.value as string });
		}
	},
	toMarkdown: {
		match: (node) => node.type.name === mathBlockId,
		runner: (state, node) => {
			state.addNode('math', undefined, node.attrs.value);
		}
	}
}));
withMeta(mathBlockSchema.ctx, { displayName: 'NodeSchemaCtx<mathBlock>' });
withMeta(mathBlockSchema.node, { displayName: 'NodeSchema<mathBlock>' });

/** Typing `$$` and a space creates a math block. */
export const mathBlockInputRule = $inputRule(
	(ctx) =>
		new InputRule(/^\$\$\s$/, (state, _match, start, end) => {
			const $start = state.doc.resolve(start);
			if (!$start.node(-1).canReplaceWith($start.index(-1), $start.indexAfter(-1), mathBlockSchema.type(ctx))) return null;
			return state.tr.delete(start, end).setBlockType(start, start, mathBlockSchema.type(ctx));
		})
);
withMeta(mathBlockInputRule, { displayName: 'InputRule<mathBlock>' });

/** All math plugins. */
export const math: MilkdownPlugin[] = [remarkMathPlugin, katexOptionsCtx, mathInlineSchema, mathBlockSchema, mathBlockInputRule, mathInlineInputRule].flat();
