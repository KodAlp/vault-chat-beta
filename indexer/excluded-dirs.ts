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
	'vault-kit'
]);
