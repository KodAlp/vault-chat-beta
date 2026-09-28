/**
 * Phase 2 owner: /settings/* routes (providers, vaults, library, skills,
 * memory, smalltalk) and their api/** backends, plus hooks.server.ts's own
 * two 403s (LOCAL_ONLY/CROSS_SITE_BLOCKED — not "settings" in the page
 * sense, but this is the only Phase-2 code list its owning agent has).
 *
 * A lot of the original Turkish validation strings this phase replaced were
 * near-duplicates of the common codes in error-codes/common.ts (VALIDATION_
 * REQUIRED's "{field} gerekli", NOT_FOUND's "{entity} bulunamadı") — those
 * are reused directly (with `field`/`entity`/`detail` params) rather than
 * re-declared here. Only genuinely distinct messages get their own code.
 */
export const SETTINGS_CODES = [
	// Vaults (api/vaults/**, server/vaults.ts) — "unknown vault" reuses the
	// common NOT_FOUND{entity:'vault',detail:id} instead of a dedicated code.
	'VAULT_NAME_EMPTY',
	'VAULT_NONE',
	'VAULT_DELETE_CONFIRM_REQUIRED',
	'VAULT_LAST_UNDELETABLE',

	// Providers (api/providers/**, server/providers/config-store.ts,
	// registry.ts) — "unknown provider" reuses the common
	// NOT_FOUND{entity:'provider',detail:id} instead of a dedicated code.
	'PROVIDER_OLLAMA_REQUIRED',
	'PROVIDER_OLLAMA_UNDELETABLE',
	'PROVIDER_OLLAMA_MISCONFIGURED',
	'PROVIDER_CONSENT_NOT_NEEDED',
	'PROVIDER_BASE_URL_INVALID',
	'PROVIDERS_FILE_UNREADABLE',

	// Generic "field present but empty" — 'VALIDATION_REQUIRED' already
	// covers "missing"; this is common.ts's missing counterpart for
	// "present, trimmed to nothing", used across more than one settings
	// surface (provider API key, ...).
	'VALIDATION_EMPTY_FIELD',

	// User skills (api/skills/**, server/userSkills.ts)
	'SKILL_NAME_INVALID',
	'SKILL_FRONTMATTER_INVALID',
	'SKILL_ZIP_ONLY',
	'SKILL_ZIP_TOO_LARGE',
	'SKILL_ZIP_UNZIP_FAILED',
	'SKILL_ZIP_ENTRY_TOO_BIG',
	'SKILL_ZIP_MD_MISSING',
	'SKILL_ZIP_MD_PARSE_FAILED',
	'SKILL_ZIP_WRITE_FAILED',
	'SKILL_EXISTS',
	'SKILL_PREVIEW_SCOPE_INVALID',
	'LIBRARY_SETTINGS_INVALID_RESPONSE_LANGUAGE',

	// Memory (api/memory/**) — "note not found" reuses the common
	// NOT_FOUND{entity:'memory'} instead of a dedicated code.
	'MEMORY_TYPE_INVALID',

	// Small talk (api/smalltalk/**) — "record not found" reuses the common
	// NOT_FOUND{entity:'record'} instead of a dedicated code.
	'SMALLTALK_LEARN_FAILED',

	// hooks.server.ts's loopback-only / cross-site / session-token gates (the
	// app's only access-control layer — see that file's own doc comments).
	'LOCAL_ONLY',
	'CROSS_SITE_BLOCKED',
	'SESSION_REQUIRED',
	'SKILL_FILE_UNREADABLE',
	'SKILL_ZIP_TOO_MANY_ENTRIES',
	'SKILL_ZIP_ENTRY_PATH_INVALID',
	'SKILL_ZIP_TOTAL_TOO_LARGE'
] as const;
