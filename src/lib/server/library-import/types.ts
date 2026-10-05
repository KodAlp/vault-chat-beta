import type { VaultContext } from '../vaults';

/**
 * Library import (generic "bring your notes from another app" feature).
 *
 * One SourceAdapter per FORMAT, not per app: Obsidian, Zettlr, Foam, Dendron
 * and a plain Markdown folder are all "a folder of .md files" and share the
 * markdown-folder adapter (the flavor is only detected, to word the preview).
 * Logseq and Joplin have their own on-disk conventions and get their own.
 *
 * Flow: detect() (cheap, ranks adapters) -> plan() (walks + builds the maps
 * transform needs, writes NOTHING) -> the user previews -> transform() per
 * entry inside common.ts runImport(), which owns the writing, indexing and
 * logging so every adapter gets the same safety rules.
 */

// One shared definition for server and client (the Library import page names adapters too).
import { ADAPTER_IDS, type AdapterId } from '../../library-import-sources';
export { ADAPTER_IDS, type AdapterId };

export function isAdapterId(x: unknown): x is AdapterId {
	return typeof x === 'string' && (ADAPTER_IDS as readonly string[]).includes(x);
}

/** Why a file was left out of the plan. These are UI codes (LibraryImport.skip_*), not error codes. */
export type SkipCode = 'unsupported' | 'tooLarge' | 'tooDeep' | 'orgFile';

export interface SkippedEntry {
	rel: string;
	reason: SkipCode;
}

/**
 * A warning is a code the UI localizes (LibraryImport.warn_*), plus an
 * optional count — kept out of the code string so no UI has to parse it.
 */
export interface ImportWarning {
	code: string;
	count?: number;
}

export interface DetectResult {
	match: boolean;
	/** 0..1. Specific markers (a .obsidian/ folder, logseq/config.edn) beat the plain-folder fallback. */
	confidence: number;
	/** markdown-folder only: obsidian | zettlr | foam | dendron | plain. */
	flavor?: string;
	warnings: ImportWarning[];
}

/** One note the plan will import. */
export interface PlanEntry {
	/** Path inside the source root, / separators. Also what the incremental log keys on (via `target`). */
	rel: string;
	/** Library-relative target WITHOUT the user's targetPrefix. */
	target: string;
	size: number;
	/** Adapter-specific extras decided at plan time (Logseq: journal / page name). */
	extra?: Record<string, unknown>;
}

export interface ImportPlan {
	adapter: AdapterId;
	flavor?: string;
	notes: number;
	/** Attachment files found in the source (they are only COPIED when a note references them). */
	attachments: number;
	skipped: SkippedEntry[];
	/** First ~10 target paths, for the preview. */
	sampleTargets: string[];
	warnings: ImportWarning[];
	/** Internal: what runImport iterates. Never sent to the client. */
	entries: PlanEntry[];
	/** Internal: adapter-private lookup tables built at plan time (link maps, uuid map...). */
	state: Record<string, unknown>;
}

export interface TransformCtx {
	v: VaultContext;
	/** realpath of the scanned source root. */
	root: string;
	plan: ImportPlan;
	/** sanitizeDomain'd folder everything is placed under, or ''. */
	prefix: string;
	/** The note's source text, already read through the safe reader (no BOM). */
	raw: string;
	/**
	 * Copies one source file (path relative to the root) into the library's
	 * shared attachments folder and returns its library-root-relative path,
	 * or null when it is missing, a symlink, too big or not an allowed type.
	 */
	copyAttachment(srcRel: string, preferredName?: string): string | null;
}

export interface TransformResult {
	/** FINAL library-relative path (prefix already applied). */
	relPath: string;
	markdown: string;
	/** True when title/domain/level had to be defaulted — the note then carries needs_review: true. */
	needsReview: boolean;
	/** Library-relative attachment paths this note now links to. */
	attachments: string[];
}

export interface SourceAdapter {
	id: AdapterId;
	/** `tree` lets detectAll walk the folder once for all adapters. */
	detect(root: string, tree?: SourceTree): Promise<DetectResult>;
	plan(root: string, tree?: SourceTree): Promise<ImportPlan>;
	transform(entry: PlanEntry, ctx: TransformCtx): Promise<TransformResult>;
}

export interface SourceFile {
	rel: string;
	size: number;
	/** Found inside an indexer-excluded dir (attachments/, templates/...): only attachments are kept from there. */
	fromExcluded?: boolean;
}

export interface SourceTree {
	root: string;
	files: SourceFile[];
	/** Directories not descended into because of the depth limit. */
	tooDeep: string[];
}
