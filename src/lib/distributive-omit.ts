/** Plain `Omit<Union, K>` collapses a discriminated union to only its
 * common keys before omitting — it doesn't distribute over the union, so
 * each variant's own fields (e.g. QuizGenerationStatus's `quizId` vs.
 * `message`) get silently erased. This does distribute. Used by the five
 * *-generation.svelte.ts stores' setStatus() helpers, which need "every
 * variant of this status union, minus `id`" as their parameter type. */
export type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
