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

export const ALL_ERROR_CODES = [
	...COMMON_CODES,
	...CHAT_CODES,
	...GENERATION_CODES,
	...IMPORT_CODES,
	...SETTINGS_CODES
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
