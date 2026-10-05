import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import {
	indexKey,
	isAttachmentName,
	isMarkdownName,
	makePlan,
	markdownFiles,
	normalizeFrontmatter,
	resolveSourceLink,
	rewriteEmbedsWith,
	rewriteMarkdownLinks,
	rewriteWikilinksWith,
	stringifyNote,
	tooDeepSkips,
	walkSource,
	withPrefix
} from './common';
import { MAX_UPLOAD_BYTES } from '../../import-extensions';
import type { DetectResult, ImportPlan, ImportWarning, PlanEntry, SkippedEntry, SourceAdapter, SourceTree, TransformCtx, TransformResult } from './types';

/**
 * One adapter for every app that stores notes as a plain folder of Markdown
 * files: Obsidian, Zettlr, Foam, Dendron and "just a folder". The folder
 * structure is kept at the target exactly as the Obsidian import always did;
 * the flavor is only detected so the preview can say what it found (and warn
 * about Dendron's naming).
 */

/** Marker files that identify the app, checked directly on the root (the walk skips dot-names). */
function detectFlavor(root: string): string {
	const has = (rel: string) => {
		try {
			return !fs.lstatSync(path.join(root, rel)).isSymbolicLink();
		} catch {
			return false;
		}
	};
	if (has('.obsidian')) return 'obsidian';
	// Zettlr keeps per-folder settings in .ztr-directory files and a .zettlr-* dotfile
	// family; I could not verify every variant, so any root entry with those prefixes counts.
	let rootNames: string[] = [];
	try {
		rootNames = fs.readdirSync(root);
	} catch {
		// unreadable root: validateScanRoot already vouched for it, treat as no markers
	}
	if (rootNames.some((n) => n.startsWith('.ztr') || n.toLowerCase().startsWith('.zettlr'))) return 'zettlr';
	if (has('.foam') || has('.vscode/foam.json')) return 'foam';
	if (has('dendron.yml') || has('dendron.code-workspace')) return 'dendron';
	return 'plain';
}

interface MarkdownState extends Record<string, unknown> {
	/** indexKey(basename or path without .md) -> target rel; first one wins (ambiguous names are an accepted edge case). */
	mdIndex: Map<string, string>;
	/** indexKey(basename or full rel) -> source rel of an attachment file. */
	attachmentIndex: Map<string, string>;
	/** every attachment's source rel, for relative-path links. */
	attachmentRels: Set<string>;
}

async function detect(root: string, tree: SourceTree = walkSource(root)): Promise<DetectResult> {
	const notes = markdownFiles(tree).length;
	const flavor = detectFlavor(root);
	const warnings: ImportWarning[] = [];
	if (flavor === 'dendron') warnings.push({ code: 'dendronDotNames' });
	return {
		match: notes > 0,
		// A named app's marker is strong evidence; "plain" is the fallback every other adapter outranks.
		confidence: flavor === 'plain' ? 0.3 : 0.9,
		flavor,
		warnings
	};
}

async function plan(root: string, tree: SourceTree = walkSource(root)): Promise<ImportPlan> {
	const flavor = detectFlavor(root);
	const entries: PlanEntry[] = [];
	const skipped: SkippedEntry[] = tooDeepSkips(tree);
	const mdIndex = new Map<string, string>();
	const attachmentIndex = new Map<string, string>();
	const attachmentRels = new Set<string>();
	let attachments = 0;

	for (const f of tree.files) {
		if (isAttachmentName(f.rel)) {
			attachments++;
			attachmentRels.add(f.rel);
			const baseKey = indexKey(path.posix.basename(f.rel));
			if (!attachmentIndex.has(baseKey)) attachmentIndex.set(baseKey, f.rel);
			attachmentIndex.set(indexKey(f.rel), f.rel);
			continue;
		}
		if (f.fromExcluded) continue;
		if (!isMarkdownName(f.rel)) {
			skipped.push({ rel: f.rel, reason: 'unsupported' });
			continue;
		}
		if (f.size > MAX_UPLOAD_BYTES) {
			skipped.push({ rel: f.rel, reason: 'tooLarge' });
			continue;
		}
		entries.push({ rel: f.rel, target: f.rel, size: f.size });
		const noExt = f.rel.replace(/\.md$/i, '');
		const baseKey = indexKey(path.posix.basename(noExt));
		if (!mdIndex.has(baseKey)) mdIndex.set(baseKey, f.rel);
		const pathKey = indexKey(noExt);
		if (!mdIndex.has(pathKey)) mdIndex.set(pathKey, f.rel);
	}

	const warnings: ImportWarning[] = flavor === 'dendron' ? [{ code: 'dendronDotNames' }] : [];
	const state: MarkdownState = { mdIndex, attachmentIndex, attachmentRels };
	return makePlan({ adapter: 'markdown-folder', flavor, attachments, skipped, warnings, entries, state });
}

async function transform(entry: PlanEntry, ctx: TransformCtx): Promise<TransformResult> {
	const state = ctx.plan.state as MarkdownState;
	const finalRel = withPrefix(ctx.prefix, entry.target);
	const copied: string[] = [];

	const parsed = matter(ctx.raw);
	const data = parsed.data as Record<string, unknown>;

	const attach = (srcRel: string | undefined, name?: string): string | null => {
		if (!srcRel) return null;
		const lib = ctx.copyAttachment(srcRel, name);
		if (lib) copied.push(lib);
		return lib;
	};
	const resolveNote = (name: string): string | undefined => {
		const bare = name.replace(/\.md$/i, '');
		const hit = state.mdIndex.get(indexKey(bare)) ?? state.mdIndex.get(indexKey(path.posix.basename(bare)));
		return hit ? withPrefix(ctx.prefix, hit) : undefined;
	};

	// Embeds first: the wikilink pass must never see the [[x]] inside ![[x]].
	let body = rewriteEmbedsWith(parsed.content, finalRel, {
		attachment: (name) =>
			attach(
				state.attachmentIndex.get(indexKey(name)) ?? state.attachmentIndex.get(indexKey(path.posix.basename(name))),
				path.posix.basename(name)
			),
		note: resolveNote
	});
	// Relative image/attachment links (![](attachments/x.png)): point them at the flat
	// shared copy, or they would dangle in the library. Links to notes keep working as-is
	// because the folder structure is preserved.
	body = rewriteMarkdownLinks(body, finalRel, (url) => {
		const src = resolveSourceLink(entry.rel, url);
		if (!src || !state.attachmentRels.has(src)) return undefined;
		return attach(src, path.posix.basename(src)) ?? undefined;
	});
	body = rewriteWikilinksWith(body, finalRel, resolveNote);

	const flavor = ctx.plan.flavor ?? 'plain';
	const { frontmatter, needsReview } = normalizeFrontmatter(data, {
		sourceRel: entry.rel,
		titleFallback: path.posix.basename(entry.rel, path.posix.extname(entry.rel)),
		// 'obsidian-import' is what the original importer wrote; the other flavors follow the same pattern.
		convertedBy: `${flavor === 'plain' ? 'markdown' : flavor}-import`
	});
	return { relPath: finalRel, markdown: stringifyNote(body, frontmatter), needsReview, attachments: copied };
}

export const markdownFolderAdapter: SourceAdapter = { id: 'markdown-folder', detect, plan, transform };
