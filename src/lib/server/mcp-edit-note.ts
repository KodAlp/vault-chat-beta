import { AppError } from './app-error';
import { sha256 } from './library-write';

/**
 * Pure edit logic behind the MCP `edit_note` tool (POST /api/mcp/notes/edit). Kept free of I/O so the
 * safety rules are unit-testable.
 *
 * Frontmatter policy: an agent can NEVER change the frontmatter block. The app relies on its keys
 * (converter, source, provenance, needs_review, ...) and a note body is untrusted-input territory, so
 * the edit is applied to the BODY only and the original frontmatter text is re-attached byte for byte.
 * `content` therefore means "the new body" (the same text get_note returns as `content`), and
 * `old_string` can only match inside the body. A body that would itself start a frontmatter block
 * (e.g. an injected leading `---` block into a note that had none) is rejected, so frontmatter cannot be
 * smuggled in either.
 */

// Same shape gray-matter accepts: optional BOM, `---`, lines, closing `---` on its own line.
const FRONTMATTER = /^﻿?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

export function splitFrontmatter(raw: string): { head: string; body: string } {
	const m = FRONTMATTER.exec(raw);
	if (!m) return { head: '', body: raw };
	return { head: m[0], body: raw.slice(m[0].length) };
}

export type NoteEdit = { content: string } | { oldString: string; newString: string };

function countOccurrences(haystack: string, needle: string, limit: number): number {
	let n = 0;
	for (let i = haystack.indexOf(needle); i !== -1 && n < limit; i = haystack.indexOf(needle, i + needle.length)) n++;
	return n;
}

/**
 * Returns the full new file text, or throws an AppError:
 *  - LIBRARY_EDIT_CONFLICT (409): `expectedHash` is not the hash of the file as it is now (lost-update guard)
 *  - MCP_EDIT_NOT_FOUND / MCP_EDIT_NOT_UNIQUE (409): old_string matches zero / more than one place in the body
 *  - VALIDATION_INVALID (400): empty old_string, or the result would change/introduce frontmatter
 */
export function applyNoteEdit(raw: string, expectedHash: string, edit: NoteEdit): string {
	if (sha256(raw) !== expectedHash) throw new AppError('LIBRARY_EDIT_CONFLICT', undefined, 409);
	const { head, body } = splitFrontmatter(raw);

	let nextBody: string;
	if ('content' in edit) {
		nextBody = edit.content;
	} else {
		if (edit.oldString.length === 0) throw new AppError('VALIDATION_INVALID', { field: 'old_string' }, 400);
		const hits = countOccurrences(body, edit.oldString, 2);
		if (hits === 0) throw new AppError('MCP_EDIT_NOT_FOUND', undefined, 409);
		if (hits > 1) throw new AppError('MCP_EDIT_NOT_UNIQUE', undefined, 409);
		const at = body.indexOf(edit.oldString);
		nextBody = body.slice(0, at) + edit.newString + body.slice(at + edit.oldString.length);
	}

	const next = head + nextBody;
	// Re-parse the result: its frontmatter must be exactly the original (covers an edit that would turn the
	// first body lines into, or close up with, a frontmatter block).
	if (splitFrontmatter(next).head !== head) throw new AppError('VALIDATION_INVALID', { field: 'content' }, 400);
	return next;
}
