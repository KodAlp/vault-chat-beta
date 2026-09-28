/**
 * Isomorphic error-code registry — imported by both server code
 * ($lib/server/app-error.ts) and client code ($lib/server-error.ts,
 * error-format.ts), so this file itself must stay free of rune/svelte
 * imports (see i18n/index.svelte.ts's own doc comment on why that module
 * can't be imported from a plain `tsx --test` unit test).
 *
 * ALL_ERROR_CODES is every code this app can emit, common infra plus each
 * Phase-2 domain list — kept as one flat union so a single ErrorCode type
 * covers every fail()/AppError call site regardless of which surface it's
 * on.
 */
import { COMMON_CODES } from './error-codes/common';
import { CHAT_CODES } from './error-codes/chat';
import { GENERATION_CODES } from './error-codes/generation';
import { IMPORT_CODES } from './error-codes/import';
import { SETTINGS_CODES } from './error-codes/settings';
import { EMBEDDING_CODES } from './error-codes/embedding';

export const ALL_ERROR_CODES = [
	...COMMON_CODES,
	...CHAT_CODES,
	...GENERATION_CODES,
	...IMPORT_CODES,
	...SETTINGS_CODES,
	...EMBEDDING_CODES
] as const;

export type ErrorCode = (typeof ALL_ERROR_CODES)[number];

export type ErrorParams = Record<string, string | number>;

export interface CodedError {
	code: string;
	params?: ErrorParams;
}

/**
 * Entity names usable as NOT_FOUND's `{entity}` param — e.g.
 * `fail('NOT_FOUND', { entity: 'quiz' })`. The client resolves `entity`
 * through `ServerErrors.entity_<name>` (see error-format.ts) before
 * interpolating it into the translated NOT_FOUND sentence, so the noun
 * itself is localized too ("Sınav bulunamadı" / "Quiz not found"), not just
 * the surrounding sentence.
 */
export const ENTITY_KEYS = [
	'chat',
	'quiz',
	'card',
	'deck',
	'report',
	'mindmap',
	'slidedeck',
	'attempt',
	'question',
	'skill',
	'vault',
	'provider',
	'note',
	'file',
	'memory',
	'record',
	'import'
] as const;

export type EntityKey = (typeof ENTITY_KEYS)[number];

/**
 * Machine-readable causes usable as a `{reason}` param on any code. The
 * client resolves `reason` through `ServerErrors.reason_<name>`: a template
 * with `{reason}` interpolates it, one without gets it appended like
 * `detail`. Used where the server has a known cause but the human text for
 * it must stay out of the wire format (e.g. a validator whose Turkish text
 * is also fed back to the model in a retry prompt).
 */
export const REASON_KEYS = [
	'disabled',
	'not_consented',
	'invalid_json',
	'invented_source_ids',
	'report_sources_not_specific',
	'report_no_sections',
	'slides_no_slides',
	'mindmap_too_few_nodes'
] as const;

export type ReasonKey = (typeof REASON_KEYS)[number];
