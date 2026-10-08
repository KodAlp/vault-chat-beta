// Timeout / ETA numbers for convert.py runs. Shared by convertQueue.ts's
// one-process-per-file path and convert-worker.ts, so neither imports the other
// just for these.

// A malformed/adversarial PDF (more likely once Faz 15 feeds this from
// arbitrary downloaded links, not just the user's own uploads) can hang
// MarkItDown indefinitely. sharedJobMutex is shared with Ollama model-swap,
// so a stuck child here blocks chat too — never wait forever.
//
// This is the floor, used until convert.py's early `pageCount` progress
// event (PDFs only) lets runConvert() replace it with a page-aware budget
// below — a flat 120s is nowhere near enough for docling: measured on an
// RTX 4050 (Aşama 7, 2026-09-23), CPU took 79 s/page and 23 s/page on an
// 8-page arXiv paper and a 12-page OSTEP chapter respectively (635s/271s
// total — both already blow past 120s alone), and even GPU with Ollama's
// qwen3:8b already resident (the worst realistic case, contention roughly
// triples docling's own idle time) took 8.8 s/page and 7.5 s/page.
export const PROCESS_TIMEOUT_MS = 120_000;

// Page-aware timeout for a PDF once pageCount is known — sized off the
// worst measured case (GPU + qwen3 loaded, ~8.8-9 s/page) with headroom for
// a larger or more complex document than the two 8-12 page fixtures this
// was measured against. Applies to every PDF tool uniformly, not just
// docling — MarkItDown is far faster in practice, so it only ever gets more
// slack, never less; Node can't know in advance which tool route_auto will
// actually pick.
// Base raised 45 -> 90 s (2026-10-08): the timer starts at the pageCount
// event, BEFORE docling loads its models, and a cold load (models read from
// disk for the first time in a fresh server) timed a 2-page PDF out at 69 s
// while the same file converted in 41 s warm.
const DOCLING_BASE_TIMEOUT_MS = 90_000;
const DOCLING_MS_PER_PAGE_TIMEOUT = 12_000;

// Optimistic (Ollama-idle) rate for the UI's "yaklaşık N saniye" estimate —
// a different number than the timeout above on purpose: most uploads don't
// happen while a chat generation is mid-stream, so the common case is worth
// showing accurately rather than always showing the pessimistic worst case.
const DOCLING_BASE_ESTIMATE_MS = 15_000;
const DOCLING_MS_PER_PAGE_ESTIMATE = 4_000;

export function pdfTimeoutMs(pageCount: number): number {
	return DOCLING_BASE_TIMEOUT_MS + pageCount * DOCLING_MS_PER_PAGE_TIMEOUT;
}

export function pdfEstimatedSeconds(pageCount: number): number {
	return Math.round((DOCLING_BASE_ESTIMATE_MS + pageCount * DOCLING_MS_PER_PAGE_ESTIMATE) / 1000);
}
