import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import matter from 'gray-matter';
import { libraryRoot, importLogPath, appendImportLog } from './library';
import { indexLibraryFile } from './incrementalIndex';
import type { ImportResultItem, ImportSummary } from '$lib/types';

const EXCLUDED_DIRS = new Set(['.obsidian', 'templates', '.trash', 'node_modules', '.git']);
const ATTACHMENT_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.pdf', '.webp']);

function sha256(content: string): string {
	return crypto.createHash('sha256').update(content).digest('hex');
}

function walkAll(dir: string, out: string[] = [], base = dir): string[] {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (EXCLUDED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) walkAll(full, out, base);
		else out.push(path.relative(base, full).split(path.sep).join('/'));
	}
	return out;
}

interface LogEntry {
	sourcePath: string;
	sha256: string;
	importedAt: string;
	status: string;
}

function loadLastKnownHashes(logPath: string): Map<string, string> {
	const known = new Map<string, string>();
	if (!fs.existsSync(logPath)) return known;
	const lines = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
	for (const line of lines) {
		try {
			const entry = JSON.parse(line) as LogEntry;
			if (entry.sourcePath) known.set(entry.sourcePath, entry.sha256);
		} catch {
			// malformed line — skip, don't let one bad entry break the whole scan
		}
	}
	return known;
}

function appendLog(_logPath: string, entry: LogEntry): void {
	appendImportLog(entry);
}

/** [[Note]] / [[Note|alias]] / [[Note#heading]] -> relative .md link, resolved
 * against a basename index built from the same walk (case-insensitive,
 * first match wins — ambiguous duplicate names are an accepted edge case). */
function rewriteWikilinks(content: string, currentRel: string, mdIndex: Map<string, string>): string {
	return content.replace(
		/\[\[([^\]|#]+)(#[^\]|]+)?(\|([^\]]+))?\]\]/g,
		(_match, target: string, _heading: string | undefined, _aliasGroup: string | undefined, alias: string | undefined) => {
			const key = target.trim().toLowerCase();
			const targetRel = mdIndex.get(key);
			const label = alias ?? target.trim();
			if (!targetRel) return label;
			// encodeURI, not raw join: an un-encoded space in a markdown link
			// destination ends the link early for most parsers (including this
			// app's), silently degrading the link to literal text.
			const relLink = encodeURI(
				path.relative(path.dirname(currentRel), targetRel).split(path.sep).join('/')
			);
			return `[${label}](${relLink})`;
		}
	);
}

/** ![[image.png]] -> markdown image, attachment copied into a flat shared
 * folder (library docs move to different relative paths than the vault, so
 * per-note-relative attachment copies would break on any future move).
 * Scoping note: copying is implemented; serving these files back to the
 * browser is not (no static route this pass) — see Faz 5 plan. */
function rewriteEmbeds(
	content: string,
	currentRel: string,
	attachmentIndex: Map<string, string>,
	sourceRoot: string,
	attachmentsDir: string
): string {
	return content.replace(/!\[\[([^\]]+)\]\]/g, (match, target: string) => {
		const base = target.trim();
		const srcRel = attachmentIndex.get(base.toLowerCase());
		if (!srcRel) return match;
		const ext = path.extname(base).toLowerCase();
		if (!ATTACHMENT_EXT.has(ext)) return match;
		fs.mkdirSync(attachmentsDir, { recursive: true });
		const destAbs = path.join(attachmentsDir, base);
		if (!fs.existsSync(destAbs)) {
			fs.copyFileSync(path.join(sourceRoot, srcRel), destAbs);
		}
		const relLink = encodeURI(
			path
				.relative(path.dirname(currentRel), path.join('_meta', 'attachments', base))
				.split(path.sep)
				.join('/')
		);
		return `![](${relLink})`;
	});
}

export async function importObsidianVault(
	sourcePath: string,
	onProgress?: (item: ImportResultItem) => void
): Promise<ImportSummary> {
	const resolvedSource = path.resolve(sourcePath);
	if (!fs.existsSync(resolvedSource) || !fs.statSync(resolvedSource).isDirectory()) {
		throw new Error('Kaynak vault yolu bulunamadı ya da bir klasör değil');
	}

	const allFiles = walkAll(resolvedSource);
	const mdFiles = allFiles.filter((f) => f.endsWith('.md'));
	const mdIndex = new Map<string, string>();
	for (const rel of mdFiles) {
		const key = path.basename(rel, '.md').toLowerCase();
		if (!mdIndex.has(key)) mdIndex.set(key, rel);
	}
	const attachmentIndex = new Map<string, string>();
	for (const rel of allFiles) {
		if (!rel.endsWith('.md') && !attachmentIndex.has(path.basename(rel).toLowerCase())) {
			attachmentIndex.set(path.basename(rel).toLowerCase(), rel);
		}
	}

	const root = libraryRoot();
	const logPath = importLogPath();
	const attachmentsDir = path.join(root, '_meta', 'attachments');
	const lastKnownHashes = loadLastKnownHashes(logPath);

	const items: ImportResultItem[] = [];

	for (const rel of mdFiles) {
		const abs = path.join(resolvedSource, rel);
		const raw = fs.readFileSync(abs, 'utf-8');
		const hash = sha256(raw);

		if (lastKnownHashes.get(rel) === hash) {
			const item: ImportResultItem = { fileName: rel, status: 'skipped' };
			items.push(item);
			onProgress?.(item);
			continue;
		}

		try {
			const parsed = matter(raw);
			const data = parsed.data as Record<string, unknown>;
			const missingRequired = !data.title && !data.topic;
			const title = (data.title as string) ?? (data.topic as string) ?? path.basename(rel, '.md');
			const domain = (data.domain as string) ?? (data.domains as string[])?.[0] ?? 'genel';
			const level = (data.level as string) ?? (data.depth as string) ?? 'undergraduate';
			const needsReview = missingRequired || !data.domain && !data.domains || !data.level && !data.depth;

			let body = rewriteWikilinks(parsed.content, rel, mdIndex);
			body = rewriteEmbeds(body, rel, attachmentIndex, resolvedSource, attachmentsDir);

			const nextFrontmatter = {
				...data,
				title,
				domain,
				level,
				source_file: rel,
				converted_by: 'obsidian-import',
				converted_at: new Date().toISOString().slice(0, 10),
				...(needsReview ? { needs_review: true } : {})
			};

			const destAbs = path.join(root, rel);
			fs.mkdirSync(path.dirname(destAbs), { recursive: true });
			fs.writeFileSync(destAbs, matter.stringify(body, nextFrontmatter), 'utf-8');

			await indexLibraryFile(destAbs, rel);

			const status = needsReview ? 'needs_review' : 'converted';
			appendLog(logPath, { sourcePath: rel, sha256: hash, importedAt: new Date().toISOString(), status });
			const item: ImportResultItem = { fileName: rel, status, path: rel };
			items.push(item);
			onProgress?.(item);
		} catch (err) {
			const item: ImportResultItem = {
				fileName: rel,
				status: 'failed',
				reason: err instanceof Error ? err.message : 'Bilinmeyen hata'
			};
			items.push(item);
			onProgress?.(item);
		}
	}

	return { items };
}
