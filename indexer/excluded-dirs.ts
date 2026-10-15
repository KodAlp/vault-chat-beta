/** Shared between index-vault.ts and watch.ts so the exclusion list can't drift apart. */
export const EXCLUDED_DIRS = new Set([
	'.obsidian',
	'templates',
	'.trash',
	'attachments',
	'node_modules',
	'.git',
	'vault-chat',
	// Agent config, not vault content — .claude/skills/*/SKILL.md frontmatter isn't
	// the {title, domain, level, ...} schema and can even break YAML parsing.
	'.claude',
	// raw/ is read-only pre-ingest staging (CLAUDE.md): unprocessed PDF conversions,
	// not the curated wiki. Indexing it would duplicate/pollute retrieval.
	'raw',
	// Unrelated bootstrap template living at the repo root, not vault content.
	'vault-kit',
	// The app's own bookkeeping inside a vault (library-write.ts): every save leaves a full copy of
	// the note under _meta/revisions/, so indexing it returned old (often broken) versions next to
	// the live note — Fizik on 2026-10-15: 50 of 68 indexed files were revisions.
	'_meta'
]);
