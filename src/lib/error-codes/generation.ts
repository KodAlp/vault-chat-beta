// Owner: quiz/cards/report/mindmap/slides generation + study routes.
//
// Each generate-*.ts throws AppError with one of these when it fails for a
// reason specific to that generator (see app-error.ts's fail()/AppError).
// Anything genuinely common (a missing field, a not-found entity, a provider
// failure) reuses COMMON_CODES instead of duplicating a code here — see
// error-codes/common.ts.
//
// GEN_STALLED is never thrown server-side: it's set client-only by the five
// *-generation.svelte.ts stores' idle watchdog (via generation-stream.ts)
// when a stream goes >120s without a chunk, so it lives here rather than in
// a client-only file since it's still part of the same ErrorCode union.
export const GENERATION_CODES = [
	'GEN_QUIZ_NO_TYPES',
	'GEN_QUIZ_EMPTY',
	'GEN_CARDS_EMPTY',
	'GEN_MINDMAP_INVALID',
	'GEN_REPORT_INVALID',
	'GEN_SLIDES_INVALID',
	'GEN_STALLED',
	'GEN_STREAM_ENDED'
] as const;
