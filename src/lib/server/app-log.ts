import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './env';

const MAX_BYTES = 5 * 1024 * 1024;

/**
 * data/app-log.jsonl — same content rule as mcp/log.ts: callers pass only
 * metadata (chat id, provider, model, error message) — never message
 * bodies, prompts, or chunk text. This is what survives a closed tab so a
 * broken run (a poisoned chats.db, a dead provider) leaves a trail instead
 * of just a silently dropped SSE stream. appendFileSync is deliberate: a
 * crash mid-write must not lose the record that would explain it.
 */
export interface AppLogRecord {
	ts: string;
	kind:
		| 'chat_error'
		| 'fallback'
		| 'title_error'
		| 'db_error'
		| 'provider_error'
		| 'vault_error'
		| 'fatal_error'
		| 'generation_error'
		/** Generation SUCCEEDED but something had to be cleaned up on the way —
		 * e.g. a mind-map node whose label was a source file name was dropped so
		 * the user would never see it. Separate from generation_error so there is
		 * a debug trail without pretending the run failed. */
		| 'generation_warning'
		/** retrieve() came back with zero chunks (NoSourcesError) — a routine
		 * user-facing state (not a bug), so kept out of generation_error's
		 * error-monitoring bucket, but logged anyway with `reason` so a
		 * recurring "kaynak bulunamadı" report is actually diagnosable instead
		 * of invisible in app-log.jsonl. */
		| 'no_sources'
		/** One record per completed model call in chat (Ollama only for now):
		 * token counts and timings, so a latency decision rests on numbers from
		 * the real request path instead of a synthetic curl. Numbers only, per
		 * this file's content rule. */
		| 'llm_timing'
		/** A chunk of the model's answer was corrupted (U+FFFD or a stray CJK
		 * character). Records which kind, how far into the answer, how long the
		 * attempt had been running, and what was done about it — the numbers that
		 * were missing to judge how often this happens and what it costs. */
		| 'output_corruption'
		/** A repetition loop (repetition-guard.ts findRepetitionLoop) was cut and the attempt stopped:
		 * `keptChars`, `removedChars`, `elapsedMs`. The turn ends normally with the trimmed answer. */
		| 'output_repetition'
		/** Reasoning that had leaked into the answer text before a stray `</think>` line was moved to
		 * the thinking section: `movedChars` (moved), `keptChars` (answer left), `elapsedMs`. */
		| 'output_think_leak'
		/** One record per chat retrieval: how many chunks came back, why none did
		 * (`reason`), how close the nearest vector match was, and whether the
		 * keyword fallback supplied them. Chat never wrote no_sources, so until this
		 * existed nobody could say how often a question got no context at all. */
		| 'retrieval'
		/** The chat reranker (reranker.ts) could not score a query and retrieval fell back to the
		 * plain vector order; `message` says why. Logged once per distinct cause, not per query. */
		| 'reranker_issue'
		/** The keyword (FTS5) fallback ran because the vector search left nothing
		 * usable: which pass (`mode`), how many query terms, raw hits, and how many
		 * survived the scope/domain/hidden-folder filters. */
		| 'retrieval_fallback'
		/** The small-talk gate (smalltalk-gate.ts) learned, was taught, was overridden or failed:
		 * `smallTalkAction` and, where there is one, `gatePhraseId`. Ids only, never the text. */
		| 'smalltalk'
		/** computeMemoryBlock (memory-runtime.ts) failed and fell back to no memory block —
		 * never an error in the user's answer. `message` only, no note/domain content. */
		| 'memory_error'
		/** computeReviewBlock (review-mode.ts) failed and fell back to no review block —
		 * same posture, `message` only. */
		| 'review_error'
		/** Güvenlik sertleştirme — hooks.server.ts's `handle` rejected a request:
		 * LOCAL_ONLY (bad Host), CROSS_SITE_BLOCKED (bad Origin) or SESSION_REQUIRED
		 * (missing/wrong vc_session). `code`/`method`/`path`/`origin` only — see
		 * those fields' own doc comments for exactly what they carry and, just as
		 * importantly, what they deliberately leave out (no query string, no
		 * cookie/header values, no token). Rate-capped in hooks.server.ts itself
		 * (a local port scanner must not be able to grow this file unboundedly
		 * between size-based rotations — see rotateIfNeeded above). */
		| 'security_block'
		/** retrieve() skipped vector search entirely: either the
		 * index's recorded embedding (index_meta) differs from the currently
		 * configured provider/model/dims (`reason: 'mismatch'`), or embedTexts()
		 * itself threw (`reason: 'unavailable'` — consent/network/dims-mismatch
		 * at the provider). `message` carries the raw AppError detail for
		 * 'unavailable'; never the query text (this file's content rule). */
		| 'embedding_issue'
		/** Converted-image cleanup (converted-image-cleanup.ts) deleted orphaned pictures: `message` carries
		 * counts only, never a file name or path. */
		| 'image_cleanup'
		/** Antivirus scan of an import (av-guard.ts): a threat was found (rejected), no scanner exists (logged once per process),
		 * or the scan itself failed / timed out (import proceeds). `message` carries engine, threat name and timing, never a path. */
		| 'av_threat'
		| 'av_unavailable'
		| 'av_error';
	chatId?: string;
	provider?: string;
	model?: string;
	/** generation_error/generation_warning/no_sources only — which of the 5
	 * generators (quiz/cards/report/mindmap/slides). Lets a silent "nothing
	 * got created" pattern (e.g. reports failing validation every single
	 * attempt) actually show up somewhere instead of only ever existing as a
	 * dropped SSE stream. */
	generationType?: string;
	/** fallback only — the ProviderErrorKind (e.g. 'http_429', 'timeout_idle')
	 * that caused this hop to be skipped, so a reader can tell a rate-limit
	 * skip apart from an outage/timeout skip without re-parsing `message`
	 * text. Kept as a loose string (not ProviderErrorKind) to avoid this
	 * module importing from providers/, which is not otherwise a dependency
	 * of app-log.ts. */
	errorKind?: string;
	/** no_sources only — see RetrieveResult.reason ($lib/types.ts): which of
	 * retrieve()'s empty-return paths caused it (unindexed vault, empty KNN
	 * result, domain/distance filtering, or scope narrowing). */
	reason?: string;
	/** llm_timing only. Token counts and milliseconds straight from the
	 * provider's final response line; `numCtx` is the window the request was
	 * served with. `nearCtxLimit` is true when prompt+completion filled 90%+ of
	 * it — the signature of a prompt Ollama may have truncated from the front. */
	promptTokens?: number;
	completionTokens?: number;
	promptMs?: number;
	completionMs?: number;
	loadMs?: number;
	numCtx?: number;
	nearCtxLimit?: boolean;
	/** llm_timing only — which retry-from-scratch attempt this call belongs to
	 * (0 = first) and why the previous attempt was thrown away, so corruption
	 * and empty-answer retries can be counted from the log with no extra code. */
	attempt?: number;
	retryReason?: string;
	/** llm_timing only — how many read_skill_file round-trips preceded this call
	 * within the attempt (0 = the first hop). */
	toolRoundTrips?: number;
	/** llm_timing, output_corruption — how many times this answer was continued
	 * from its clean prefix instead of regenerated. */
	resumeCount?: number;
	/** output_corruption only. `corruptKind`: 'fffd' (U+FFFD) or 'cjk' (stray
	 * Chinese character). `charIndex`: offset of the bad character in the answer
	 * so far. `keptChars`: how much clean text was kept (0 on a restart).
	 * `elapsedMs`: how long this attempt had been generating — WASTED time when
	 * `action` is a restart, retained time when it is a resume. `action`:
	 * 'resume' | 'restart' | 'resume_retry' (a resume whose first words did not
	 * line up with what the user had seen; the same seam is tried again) |
	 * 'resume_mismatch' (the retries ran out, so it fell back to a restart).
	 * `restartReason`: why a restart was chosen (resume-plan.ts RestartReason). */
	corruptKind?: 'fffd' | 'cjk';
	charIndex?: number;
	keptChars?: number;
	elapsedMs?: number;
	action?: 'resume' | 'restart' | 'resume_mismatch' | 'resume_retry';
	restartReason?: string;
	/** output_repetition: characters cut from the answer. output_think_leak: characters moved to thinking. */
	removedChars?: number;
	movedChars?: number;
	/** retrieval, retrieval_fallback. `chunks`: usable chunks returned.
	 * `bestDistance`: nearest vector match's cosine distance (retrieval only).
	 * `keyword`: the chunks came from the keyword fallback. `mode`/`terms`/`hits`:
	 * the fallback pass ('and' | 'or' | 'co2'), its query-term count and raw FTS hits. */
	chunks?: number;
	bestDistance?: number;
	keyword?: boolean;
	/** retrieval: whether the reranker scored this turn's candidates, and its best score. */
	rerank?: boolean;
	rerankBest?: number;
	mode?: 'and' | 'or' | 'co2';
	terms?: number;
	hits?: number;
	/** retrieval: the message was judged small talk (`smallTalk`) and by what — `gateSim`
	 * similarity to the closest phrase, `gateVia` 'personal' | 'seed', `gatePhraseId` — or
	 * the user asked for sources anyway (`gateOverridden`). smalltalk: `smallTalkAction`. */
	smallTalk?: boolean;
	gateSim?: number;
	gateVia?: string;
	gatePhraseId?: number;
	gateOverridden?: boolean;
	smallTalkAction?: 'learned' | 'taught' | 'confirmed_question' | 'error';
	/** security_block only — the stable error code that was returned
	 * ('LOCAL_ONLY' | 'CROSS_SITE_BLOCKED' | 'SESSION_REQUIRED'). Kept as a
	 * loose string (not ErrorCode) for the same reason errorKind is: this
	 * module doesn't otherwise import from the isomorphic errors registry. */
	code?: string;
	/** security_block only — event.request.method. */
	method?: string;
	/** security_block only — event.url.pathname ONLY, never the full URL: the
	 * query string is exactly where a vc_session token or other sensitive
	 * value would end up if this ever logged it, so it never gets the
	 * chance. */
	path?: string;
	/** security_block only — the request's Origin header, or its Host header
	 * when there was no Origin (e.g. a plain GET navigation, which browsers
	 * don't attach an Origin to). Whichever it is names where the request
	 * SAYS it came from, which is exactly the signal worth keeping for a
	 * rejected request — never a cookie or header VALUE. */
	origin?: string;
	message: string;
}

function logPath(): string {
	return path.join(dataDir(), 'app-log.jsonl');
}

function rotateIfNeeded(p: string): void {
	try {
		const stat = fs.statSync(p);
		if (stat.size > MAX_BYTES) fs.renameSync(p, `${p}.1`);
	} catch {
		// file doesn't exist yet — nothing to rotate
	}
}

/** Never throws — a logging failure must never break the caller's real work. */
export function logAppEvent(record: Omit<AppLogRecord, 'ts'>): void {
	try {
		const p = logPath();
		rotateIfNeeded(p);
		fs.appendFileSync(p, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`, 'utf-8');
	} catch {
		// swallowed — see doc comment above
	}
}

/**
 * The most recent 'fallback' event per provider that actually carried an
 * errorKind — the Ayarlar > Sağlayıcılar page's fallback for cloud providers
 * (Gemini, OpenRouter) whose success responses never carry live rate-limit
 * headers, unlike Groq/Mistral (see registry.ts's getRateLimitInfo). The
 * file is append-only and chronological, so a single forward pass keeping
 * "last seen per provider" is enough — no sort needed. Never throws; an
 * unreadable or missing log file is just "no data yet".
 */
export function getLastProviderErrors(): Record<string, { ts: string; kind: string }> {
	const result: Record<string, { ts: string; kind: string }> = {};
	let raw: string;
	try {
		raw = fs.readFileSync(logPath(), 'utf-8');
	} catch {
		return result;
	}
	for (const line of raw.split('\n')) {
		if (!line.trim()) continue;
		let rec: AppLogRecord;
		try {
			rec = JSON.parse(line);
		} catch {
			continue;
		}
		if (rec.kind !== 'fallback' || !rec.provider || !rec.errorKind) continue;
		result[rec.provider] = { ts: rec.ts, kind: rec.errorKind };
	}
	return result;
}
