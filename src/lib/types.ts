/**
 * Shared contract between the indexer (writes) and the app (reads).
 * If this shape and indexer/db.ts's `chunks` table diverge, TypeScript
 * catches it at compile time rather than the app silently misreading columns.
 */
export interface RetrievedChunk {
	path: string;
	heading_path: string;
	display_text: string;
	topic: string;
	depth: string;
	domains: string[];
	/** Cosine distance. For a chunk found by the keyword fallback (via === 'keyword')
	 * this is a placeholder (1), NOT a distance — nothing reads it. */
	distance: number;
	/** Set only for chunks the keyword fallback found (retrieve.ts). */
	via?: 'keyword';
	/** Cross-encoder relevance (sigmoid, 0-1); set only when the chat reranker ran (rerank-select.ts). */
	rerankScore?: number;
}

/**
 * narrowScope distinguishes "nothing relevant in the vault" from "relevant
 * chunks exist but includedPaths filtered them all out" — the two look
 * identical as a bare empty array, but only the second should trigger a
 * "kapsamı genişlet?" suggestion in the UI (Faz 9).
 */
export interface RetrieveResult {
	chunks: RetrievedChunk[];
	narrowScope: boolean;
	/** Set only when chunks is empty — which of retrieve()'s empty-return
	 * paths produced it, for app-log.ts's no_sources record. 'scope' is the
	 * log-side counterpart of narrowScope=true. */
	reason?:
		| 'unindexed'
		| 'no-embedding-match'
		| 'filtered'
		| 'scope'
		| 'small-talk'
		/** The reranker scored every candidate below RERANK_MIN_SCORE: the vault has nothing on this question (rerank-select.ts). */
		| 'rerank-no-match'
		/** Aşama 4a — vector search never ran: no embedding configured (FTS-only mode) and the keyword search found nothing. */
		| 'fts-only'
		/** Aşama 4a — vector search never ran because it could not (mismatch/unavailable) and the keyword fallback found nothing. */
		| 'embedding-unavailable';
	/** True when the message was judged small talk (a greeting, slang, a test) and
	 * retrieval was skipped on purpose — no sources, and the UI says why. Only ever
	 * set with opts.smallTalkGate (the chat route). */
	smallTalk?: boolean;
	/** Why the small-talk gate flagged the message; `overridden` when the user asked
	 * for sources anyway ("Yine de kaynak ara") and retrieval ran regardless. Logging
	 * and the route's learning step read it; the client never needs it. */
	gate?: {
		via?: 'personal' | 'seed';
		phraseId?: number;
		phraseSource?: 'seed' | 'auto' | 'user';
		sim: number;
		overridden?: boolean;
	};
	/** True when the vector search came back empty and these chunks are the
	 * keyword fallback's (F5). Only ever set with opts.keywordFallback. */
	keyword?: boolean;
	/** Best cosine distance among the vector candidates, whether or not they
	 * passed the filters — logging only (app-log.ts 'retrieval'). Absent when KNN
	 * returned nothing. */
	bestDistance?: number;
	/** Highest reranker score among the candidates — set only when the reranker ran. */
	rerankBest?: number;
	/**
	 * Aşama 3a — set when retrieve() could not run vector search at all against
	 * the currently configured embedding provider/model: 'mismatch' means the
	 * index's recorded embedding (index_meta) differs from the config (a
	 * reindex is required before vectors are comparable again); 'unavailable'
	 * means embedTexts() itself threw (consent missing, network/HTTP failure,
	 * or a returned vector's dimension didn't match). In both cases `chunks`
	 * may still be non-empty — the FTS keyword fallback runs regardless of
	 * `keywordFallback` when this is set — but a caller that must never cite an
	 * un-vetted keyword hit (the five generate-*.ts, per NoSourcesError's own
	 * "cite only what vector search actually found" rule) checks this FIRST
	 * and fails with a coded EMBEDDING_MISMATCH/EMBEDDING_UNAVAILABLE error
	 * instead of using `chunks`. 'fts-only' (Aşama 4a) is the EXPECTED state
	 * when no embedding provider is configured at all: keyword search is the
	 * only retrieval, so the chat route does not forward it to the client as a
	 * warning, and the generators proceed with the keyword hits (assertNoEmbeddingIssue). The chat route is the one caller that
	 * continues with the FTS results anyway, surfacing this on the client
	 * payload instead (see StreamEvent's 'done' variant).
	 */
	embeddingIssue?: 'mismatch' | 'unavailable' | 'fts-only';
}

export type ChatRole = 'user' | 'assistant';

export interface ChatMessage {
	id: string;
	role: ChatRole;
	content: string;
	thinking?: string;
	sources?: RetrievedChunk[];
	interrupted?: boolean;
	/** Client-only, never persisted — provider-fallback notices ("deepseek
	 * unavailable → switched to local model") that arrived while this
	 * message streamed in. Rendered as a system aside, not assistant prose.
	 * Structured (code/params), not a plain string, so Message.svelte can
	 * localize it the same way a StreamEvent 'notice'/'error' is — see
	 * server-error.ts's localizeError. `message` is the same log-friendly
	 * fallback text the server sent, used only if `code` fails to resolve. */
	notices?: { message: string; code?: string; params?: Record<string, string | number> }[];
	/** Mirrors RetrieveResult.narrowScope for this message's answer — set
	 * when retrieve() found relevant chunks but a scope filter excluded all
	 * of them. Drives Message.svelte's "kapsamı genişlet?" suggestion. */
	narrowScope?: boolean;
	/** Mirrors RetrieveResult.smallTalk: no sources were looked up because the
	 * message read as small talk. Drives Message.svelte's "Yine de kaynak ara". Client-only. */
	smallTalk?: boolean;
	/** Client-only: the user pressed "Kaynaklar alakasız" on this answer. */
	taughtSmallTalk?: boolean;
	/** The reranker searched the notes and judged nothing relevant (RetrieveResult reason 'rerank-no-match').
	 * Drives Message.svelte's "not in your notes" banner, which does not depend on the model saying so. Client-only. */
	noRelevantSources?: boolean;
	/** The 3-4 distinct topics (frontmatter domains) this answer's sources came from, set only when there
	 * are at least 3 and the request had no topic filter. Drives Message.svelte's "ask within one topic"
	 * banner. Client-only, never persisted — same footing as narrowScope/smallTalk. */
	topicSpread?: string[];
	/** Hedge/uncertainty phrases detected in this message's reasoning trace (when there was one) and its
	 * final answer text (always) — see $lib/server/hallucination.ts. Empty/absent means none found. */
	hedges?: string[];
	/** F8 — true when some model call this turn came close to the context window (see history-limits.ts /
	 * env.ts's serveCtxOverride). Client-only, never persisted — same footing as narrowScope/smallTalk. */
	nearCtxLimit?: boolean;
	/** Mirrors RetrieveResult.embeddingIssue for this message's answer — see
	 * StreamEvent's 'done' variant. Client-only, never persisted, same footing
	 * as narrowScope/smallTalk/nearCtxLimit above (a reload loses the banner,
	 * not the answer, which already reflects whatever sources were actually
	 * used). No UI reads this yet (Aşama 3c) — the field just carries the
	 * signal through so that phase doesn't need another server round-trip. */
	embeddingIssue?: 'mismatch' | 'unavailable';
	/** Client-only, never persisted — same footing as `notices` above: a
	 * folder-skill's supporting file the model fetched mid-turn via the
	 * read_skill_file tool. A page reload loses this "📄 read" chip, but the
	 * answer text (already built from the fetched content) survives, since
	 * the tool round-trip only ever lives in that one request's local prompt
	 * — see /api/chat/+server.ts's tool hop-loop. */
	toolCalls?: { skill: string; path: string; status: 'reading' | 'done' | 'error'; error?: string }[];
}

export interface ChatRequestBody {
	messages: ChatMessage[];
	model: string;
	/** Which provider `model` belongs to (see ProviderModelOption.providerId)
	 * — omitted means "let the task's provider chain in providers.json
	 * decide", the pre-Faz-17 behavior. Set whenever the user picked a
	 * model from Chat.svelte's header selector (which is already grouped by
	 * provider) or a settings.svelte.ts default*Provider is in play — see
	 * registry.ts's chatWithFallback pinnedProviderId param. */
	provider?: string;
	domains?: string[];
	think?: boolean;
	chatId?: string;
	/** Model for background title generation on a new chat — settings.defaultModel
	 * client-side. Falls back server-side if omitted. */
	titleModel?: string;
	/** Which provider titleModel belongs to — settings.defaultProvider
	 * client-side. Without this, title.ts's chatWithFallback call had no
	 * provider to pin titleModel to, so a non-Ollama titleModel (e.g.
	 * "deepseek-chat") could be requested from whatever the `title` chain's
	 * own default provider happened to be. See registry.ts's resolveHopModel. */
	titleProvider?: string;
	/** Vault id — omitted in Faz 8 (single active-vault UI), sent by Faz 9's
	 * vault-aware chat header. Server falls back to the active vault. */
	vault?: string;
	/** Tri-state source-tree selection (Faz 9 UI) — omitted means "all". */
	includedPaths?: string[];
	/** "Yine de kaynak ara": retrieve even if the small-talk gate would skip it, and
	 * record that this message is a question. */
	forceSources?: boolean;
	/** F6 — 'free_chat' (default, omit) | 'review'. Travels with every request the same way model/provider do
	 * (Chat.svelte's chatMode) — see prompt.ts's buildPromptMessages. */
	mode?: string;
}

export interface OllamaModel {
	name: string;
	size: number;
	modified_at: string;
}

/** Client-safe mirror of chats-db.ts's ChatRow — that module is server-only
 * ($lib/server/), can't be imported from a component. Kept structurally
 * identical to what GET /api/chats actually returns (it sends the full row,
 * including vault_id/included_paths_json — Faz 8 added those columns
 * before any client type declared them). */
export interface ChatSummary {
	id: string;
	title: string | null;
	model: string;
	vault_id: string;
	included_paths_json: string | null;
	created_at: string;
	updated_at: string;
}

/** SSE event shapes streamed by POST /api/chat. */
export type StreamEvent =
	| { type: 'chatId'; chatId: string }
	| { type: 'delta'; content: string }
	| { type: 'thinking'; content: string }
	/** Provider fallback notice (e.g. "deepseek unavailable → switched to
	 * local model") — see the model-provider skill's fallback policy.
	 * Rendered via FallbackNotice.svelte (Faz 9 Adım 6); today's
	 * single-provider chains never actually trigger it in practice. */
	| { type: 'notice'; message: string; code?: string; params?: Record<string, string | number> }
	/** A folder-skill's supporting file is about to be read via the
	 * read_skill_file tool — see /api/chat/+server.ts's tool hop-loop. */
	| { type: 'toolCall'; skill: string; path: string }
	| { type: 'toolResult'; skill: string; path: string; ok: boolean; error?: string }
	| {
			type: 'done';
			sources: RetrievedChunk[];
			narrowScope?: boolean;
			smallTalk?: boolean;
			/** See ChatMessage.noRelevantSources. */
			noRelevantSources?: boolean;
			/** See ChatMessage.topicSpread. */
			topicSpread?: string[];
			hedges?: string[];
			nearCtxLimit?: boolean;
			/** Mirrors RetrieveResult.embeddingIssue — set when this answer's sources
			 * (if any) came from the FTS keyword fallback because vector search
			 * couldn't run (index/config mismatch, or the embedding provider was
			 * unavailable), so the client can show a banner instead of presenting
			 * them as normal semantic matches. See ChatMessage.embeddingIssue. */
			embeddingIssue?: 'mismatch' | 'unavailable';
	  }
	| { type: 'error'; message: string; code?: string; params?: Record<string, string | number> }
	/** A U+FFFD (corrupted-output) retry is starting — the client must
	 * discard whatever partial content/thinking it already rendered for
	 * this message before further `delta`/`thinking` events arrive, since
	 * the server is regenerating from scratch. See api/chat/+server.ts's
	 * corruption-retry loop. */
	| { type: 'regenerate' }
	/** The visible answer (and, when given, the thinking) is replaced as a whole by these texts —
	 * unlike `regenerate` nothing else is reset: notices, sources and tool calls stay. Sent when the
	 * server trims a repetition loop off the answer, or moves reasoning that leaked into the answer
	 * (before a stray `</think>`) to the thinking section. */
	| { type: 'replaceContent'; content: string; thinking?: string };

export interface QuizGenerationRequest {
	domains?: string[];
	chatId?: string;
	prompt: string;
	composition: { mc: number; tf: number; open: number };
	model: string;
	/** See ChatRequestBody.provider's doc comment — same optional pin. */
	provider?: string;
	vault?: string;
	/** Tri-state source-tree selection (same field/semantics as
	 * ChatRequestBody.includedPaths) — omitted means "all". */
	includedPaths?: string[];
	/** Settings.quizLevelLabels — experimental cognitive-level labels on the generated questions. Absent = off. */
	levels?: boolean;
}

/** SSE event shapes streamed by POST /api/generate/quiz. `narrowScope` on
 * the error event mirrors RetrieveResult.narrowScope — set when relevant
 * chunks exist but includedPaths filtered them all out, so the UI can
 * offer "kapsamı genişlet?" instead of a flat "no sources" message. */
export type QuizGenerationEvent =
	| { type: 'progress'; stage: 'retrieving' | 'generating' | 'validating' | 'retrying'; elapsedMs?: number }
	/** `delivered` < `requested` means the sources did not hold that many DISTINCT questions: the quiz is shorter than asked
	 * rather than padded with repeats (generate-quiz.ts). Both optional so an older server's event still parses. */
	| { type: 'done'; quizId: string; requested?: number; delivered?: number }
	| { type: 'error'; message: string; narrowScope?: boolean; code?: string; params?: Record<string, string | number> };

/** GET /api/study/{quizzes,decks,reports,mindmaps,slidedecks} response
 * item shape (Faz 13) — one per generated-material type, all structurally
 * identical (mirrors study-db.ts's StudyListRow). Lets a single
 * "recently generated" list component work across all five types. */
export interface StudySummary {
	id: string;
	title: string;
	model: string;
	createdAt: string;
}

export type QuizItemType = 'multiple_choice' | 'true_false' | 'open';

export interface QuizItemView {
	id: string;
	type: QuizItemType;
	question: string;
	options: string[] | null;
	source_path: string;
	heading_path: string;
}

export interface QuizView {
	id: string;
	title: string;
	model: string;
}

export interface SubmitAttemptRequest {
	answers: { itemId: string; given: string }[];
	/** For grading open questions — settings.fastModel client-side. */
	fastModel: string;
	/** Which provider fastModel belongs to — settings.fastProvider
	 * client-side. Without this, grade-open.ts's chatWithFallback call had no
	 * provider to pin fastModel to. See registry.ts's resolveHopModel. */
	fastProvider?: string;
	vault?: string;
}

export interface AttemptResultItem {
	itemId: string;
	question: string;
	type: QuizItemType;
	options: string[] | null;
	given: string;
	correctAnswer: string;
	explanation: string;
	isCorrect: boolean;
	modelFeedback: string | null;
	sourcePath: string;
	headingPath: string;
	/** The user flagged this question as faulty (client-side toggle; see /api/study/quizzes/[id]/items/[itemId]). */
	flagged?: boolean;
}

export interface SubmitAttemptResponse {
	score: number;
	items: AttemptResultItem[];
}

export interface CardGenerationRequest {
	domains?: string[];
	chatId?: string;
	prompt: string;
	count: number;
	model: string;
	/** See ChatRequestBody.provider's doc comment — same optional pin. */
	provider?: string;
	vault?: string;
	includedPaths?: string[];
}

/** SSE event shapes streamed by POST /api/generate/cards. */
export type CardGenerationEvent =
	| { type: 'progress'; stage: 'retrieving' | 'generating' | 'validating' | 'retrying'; elapsedMs?: number }
	| { type: 'done'; deckId: string }
	| { type: 'error'; message: string; narrowScope?: boolean; code?: string; params?: Record<string, string | number> };

export type Grade = 'again' | 'hard' | 'good' | 'easy';

export interface CardView {
	id: string;
	front: string;
	back: string;
	source_path: string;
	heading_path: string;
}

export interface ReportGenerationRequest {
	domains?: string[];
	chatId?: string;
	prompt: string;
	model: string;
	/** See ChatRequestBody.provider's doc comment — same optional pin. */
	provider?: string;
	vault?: string;
	includedPaths?: string[];
}

/** SSE event shapes streamed by POST /api/generate/report. */
export type ReportGenerationEvent =
	| { type: 'progress'; stage: 'retrieving' | 'generating' | 'validating' | 'retrying'; elapsedMs?: number }
	| { type: 'done'; reportId: string }
	| { type: 'error'; message: string; narrowScope?: boolean; code?: string; params?: Record<string, string | number> };

export interface ReportView {
	id: string;
	title: string;
	model: string;
}

export interface ReportSectionView {
	id: string;
	heading: string;
	body_markdown: string;
	source_paths: string[];
}

export interface MindMapGenerationRequest {
	domains?: string[];
	chatId?: string;
	prompt: string;
	model: string;
	/** See ChatRequestBody.provider's doc comment — same optional pin. */
	provider?: string;
	vault?: string;
	includedPaths?: string[];
}

/** SSE event shapes streamed by POST /api/generate/mindmap. `elapsedMs` is
 * a heartbeat — fired every ~10s during the model call so a slow-but-
 * healthy generation doesn't read as hung on a static "generating" state;
 * see generate-mindmap.ts's callModel(). Absent on stage transitions that
 * don't wrap a model call (retrieving/validating). */
export type MindMapGenerationEvent =
	| { type: 'progress'; stage: 'retrieving' | 'generating' | 'validating' | 'retrying'; elapsedMs?: number }
	| { type: 'done'; mindmapId: string }
	| { type: 'error'; message: string; narrowScope?: boolean; code?: string; params?: Record<string, string | number> };

export interface MindMapView {
	id: string;
	title: string;
	model: string;
	/** What the topic MEANS — rendered on the map's root node. Empty for maps
	 * generated before the root carried a definition. */
	rootSummary: string;
}

export interface MindMapNodeView {
	id: string;
	path: string[];
	/** One sentence explaining this node, shown as its child in the map. */
	summary: string;
	source_path: string;
	heading_path: string;
}

export interface SlidesGenerationRequest {
	domains?: string[];
	chatId?: string;
	prompt: string;
	model: string;
	/** See ChatRequestBody.provider's doc comment — same optional pin. */
	provider?: string;
	vault?: string;
	includedPaths?: string[];
}

/** SSE event shapes streamed by POST /api/generate/slides. Terminal field is
 * `slideDeckId`, not `deckId` — cards already owns a `decks` table and
 * `CardGenerationEvent.deckId`; reusing that name here would silently read
 * as a card-deck reference at every call site. */
export type SlidesGenerationEvent =
	| { type: 'progress'; stage: 'retrieving' | 'generating' | 'validating' | 'retrying'; elapsedMs?: number }
	| { type: 'done'; slideDeckId: string }
	| { type: 'error'; message: string; narrowScope?: boolean; code?: string; params?: Record<string, string | number> };

export interface SlideDeckView {
	id: string;
	title: string;
	model: string;
	rendered_html: string;
	rendered_css: string;
}

export interface SlideView {
	id: string;
	position: number;
	/** F13-1 (Aşama 9) — see slides-schema.ts's SLIDE_LAYOUTS. */
	layout: string;
	heading: string;
	content_markdown: string;
	/** Presenter-only note, never rendered onto the slide itself; not
	 * currently surfaced anywhere in study/slides/[id]/+page.svelte's
	 * viewer — persisted for a future speaker-notes view. */
	notes: string | null;
	source_path: string;
}

export type UserSkillScope = 'chat' | 'quiz' | 'flashcards' | 'mindmap' | 'report' | 'slides';

export interface UserSkillStatus {
	name: string;
	/** Path relative to data/skills/, e.g. "_examples/notation-preference.md"
	 * — for a folder-skill, this points at its SKILL.md. */
	relPath: string;
	description: string | null;
	scope: 'all' | UserSkillScope[];
	enabled: boolean;
	priority: number;
	charCount: number;
	truncated: boolean;
	parseError: string | null;
	/** True when this skill came from a data/skills/<name>/SKILL.md folder
	 * (zip-uploaded) rather than a flat data/skills/<name>.md file. */
	isFolder?: boolean;
	/** Supporting files inside the folder (relative to it, SKILL.md excluded)
	 * — only set when isFolder is true. What the read_skill_file tool can
	 * fetch mid-chat when the active model supports tool-calling. */
	files?: string[];
}

/** Client-safe mirror of vaults.ts's VaultRecord — that module is server-only
 * ($lib/server/), can't be imported from a component. */
export interface VaultRecord {
	id: string;
	name: string;
	path: string;
	createdAt: string;
	lastOpenedAt: string;
	/** İ6 (Aşama 8) — see the server-side VaultRecord's own doc comment. */
	mcpExposed?: boolean;
	/** Set when an MCP client created the vault (server VaultRecord.createdVia). */
	createdVia?: 'mcp';
	/** Auto-confirm mode for MCP imports (server VaultRecord.mcpAutoConfirm); absent means 'off'. */
	mcpAutoConfirm?: 'off' | 'clean' | 'all';
}

/** VaultRecord plus a computed, non-persisted field — api/vaults/+server.ts
 * and +page.server.ts both add this via retrieve.ts's countUnindexedFiles();
 * it never lives in vaults.json itself (see api/vaults/+server.ts's doc
 * comment). Files on disk that `npm run index` would walk but hasn't yet —
 * a curation pass that finished without a following reindex looked, before
 * this existed, identical to a vault with nothing new (E2). */
/** One row of GET /api/library/pending-imports (server: pending-imports.ts PendingImportMeta). */
export interface PendingImportItem {
	importId: string;
	status: 'queued' | 'converting' | 'ready' | 'error';
	source: { kind: 'path' | 'url'; name: string };
	proposed: { title: string; domain: string; level: string };
	warnings: string[];
	error?: { code: string; params?: Record<string, string | number> };
	by: 'mcp' | 'app';
	createdAt: string;
	updatedAt: string;
}

export interface VaultWithStatus extends VaultRecord {
	unindexedCount: number;
	/** Aşama 3c — true when this vault's index was built under a different
	 * embedding provider/model/dims than the one currently configured
	 * (providers/config-store.ts's `embedding` block, GET /api/embedding).
	 * Vector search is skipped for this vault (retrieve.ts) until it's
	 * reindexed — see retrieve.ts's checkEmbeddingMismatch(). False for a
	 * vault that has never been indexed at all (nothing to compare against;
	 * that case is unindexedCount's job, not this one's). */
	embeddingMismatch: boolean;
	/** Present only when embeddingMismatch is true — what the index actually
	 * has vs. what's configured now, for the tooltip/banner message. */
	embeddingMismatchDetail?: {
		indexProvider: string;
		indexModel: string;
		indexDims: number;
		configProvider: string;
		configModel: string;
		configDims: number;
	};
}

/**
 * Aşama 3c — client-facing mirror of providers/config-store.ts's
 * EmbeddingConfig (server-only module, not importable from client code) —
 * the shape GET/PUT /api/embedding exchange.
 */
export interface EmbeddingConfig {
	providerId: string;
	model: string;
	dims: number;
	distanceThreshold?: number;
}

export interface LibraryNode {
	name: string;
	/** Relative to data/library/, forward-slash separated. */
	path: string;
	type: 'file' | 'folder';
	needsReview?: boolean;
	children?: LibraryNode[];
}

export interface LibrarySettings {
	keepOriginals: boolean;
	/** Sohbet sistem promptunun birincil yanıt dili (ilk eleman) + U+FFFD/CJK
	 * sızıntı algılayıcının CJK muafiyet listesi (tüm elemanlar) — bkz.
	 * $lib/server/prompt.ts'nin coreIntro()'su. Boş bırakılamaz, her zaman en
	 * az bir dil içerir. */
	allowedLanguages: string[];
	/** Sohbet yanıt dili modu. 'match' (varsayılan): son kullanıcı mesajının kendi dili
	 * belirleyicidir (bkz. $lib/server/response-language.ts'nin decideResponseLanguage'ı) —
	 * İngilizce bir soru İngilizce, Türkçe bir soru Türkçe cevaplanır, sohbetin önceki dili değil.
	 * 'fixed': eski davranış, her zaman allowedLanguages[0] (birincil dil) kullanılır — dil
	 * öğrenme kasaları için (ör. hedef dil Korece olan bir kasada her cevabın Korece kalması
	 * gerekir, soru hangi dilde sorulursa sorulsun). */
	responseLanguage: 'match' | 'fixed';
	/** Kök-seviye klasör adları (library root'a göre) — SourceTree.svelte'de
	 * hiç gösterilmez VE retrieve.ts'de hiçbir üreticiye/sohbete kaynak
	 * olarak sunulmaz (bkz. select-chunks.ts'nin excludedPrefixes'i).
	 * /settings/library'deki yönetim ağacı (LibraryTree.svelte) bundan
	 * etkilenmez — o her zaman her şeyi gösterir. */
	hiddenFolders: string[];
	/** Kök-seviye klasör adları — SourceTree.svelte'de bu klasörün kendisi
	 * gizlenir ve doğrudan çocukları kökte gösterilir (yollar değişmez,
	 * sadece ağacın görsel şekli). raw/cards/frontier gibi defter tutma
	 * klasörleriyle karışmasın diye wiki/ varsayılan olarak burada. */
	flattenFolders: string[];
}

export type ImportResultStatus = 'converted' | 'skipped' | 'needs_review' | 'failed' | 'pending';

export interface ImportResultItem {
	/** Unique per item (server-assigned crypto.randomUUID()) — the list-key a
	 * result list must use instead of fileName, which collides whenever two
	 * different files/links share a display name (two `index.md` in
	 * different folders, the same URL retried). */
	id: string;
	fileName: string;
	status: ImportResultStatus;
	/** Set to `code` (or left as a human string for a still-unconverted
	 * call site) — kept for logs/back-compat; the UI should prefer
	 * `localizeError({ code, params, message: reason })`. */
	reason?: string;
	/** Present alongside `reason` once this item's failure has been
	 * converted to the coded-error scheme (see $lib/errors.ts). */
	code?: string;
	params?: Record<string, string | number>;
	path?: string;
	/** Only set when status is 'pending' (Aşama 6 #10): the links importer
	 * now stages each result instead of writing it straight into the
	 * library, matching the file/YouTube upload flow's staging → confirm
	 * step — these three fields are what a per-item confirm/cancel UI needs,
	 * the same shape the 'ready' event already carries for a single upload. */
	importId?: string;
	proposed?: { title: string; domain: string; level: string };
	warnings?: string[];
}

export interface ImportSummary {
	items: ImportResultItem[];
}

/** SSE event shapes streamed by POST /api/import and /api/import/batch. */
export type ImportEvent =
	// pageCount/estimatedSeconds (Aşama 7, 2026-09-23): only present once
	// convert.py's early PDF page-count event reaches convertQueue.ts —
	// absent for non-PDF sources and for every progress event before it.
	| { type: 'progress'; stage: string; fileName?: string; pageCount?: number; estimatedSeconds?: number }
	| { type: 'ready'; importId: string; proposed: { title: string; domain: string; level: string }; warnings: string[] }
	| { type: 'item'; item: ImportResultItem }
	| { type: 'done'; summary?: ImportSummary }
	| { type: 'error'; message: string; code?: string; params?: Record<string, string | number> };

/** SSE event shapes streamed by POST /api/library/reimport (the re-converted note text, not yet saved). */
export type ReimportEvent =
	| { type: 'progress'; stage: string; pageCount?: number; estimatedSeconds?: number }
	| { type: 'ready'; content: string; warnings: string[] }
	| { type: 'error'; message: string; code?: string; params?: Record<string, string | number> };

/** SSE event shapes streamed by POST /api/library/import-source/run (and the older /import-obsidian wrapper). */
export type LibraryImportEvent =
	| { type: 'progress'; stage: string; fileName?: string }
	| { type: 'item'; item: ImportResultItem }
	| { type: 'done'; summary: ImportSummary }
	| { type: 'error'; message: string; code?: string; params?: Record<string, string | number> };

/** Alias kept for the pre-generalization name. */
export type ObsidianImportEvent = LibraryImportEvent;

/** SSE event shapes streamed by POST /api/system/python (pip install run). */
export type PythonSetupEvent =
	| { type: 'log'; line: string }
	| { type: 'done'; ok: boolean }
	| { type: 'error'; message: string; code?: string; params?: Record<string, string | number> };

/**
 * Aşama 3b — SSE event shapes streamed by POST /api/vaults/[id]/reindex (a
 * full, in-process rebuild of that vault's index under the currently
 * configured embedding — see src/lib/server/reindex.ts). 'cancelled' is
 * distinct from 'error': a user-requested cancel (DELETE on the same route,
 * or the client disconnecting) is not a failure, same posture as the chat
 * route's own AbortError handling.
 */
export type ReindexEvent =
	| { type: 'start'; total: number }
	| { type: 'progress'; done: number; total: number; path: string }
	| { type: 'done'; files: number; chunks: number; ms: number }
	| { type: 'cancelled' }
	| { type: 'error'; message: string; code?: string; params?: Record<string, string | number> };

/** #61 - SSE events streamed by POST /api/settings/backup. */
export type BackupEvent =
	| { type: 'start'; total: number }
	| { type: 'progress'; done: number; total: number; path: string }
	| {
			type: 'done';
			folder: string;
			ok: boolean;
			files: number;
			databases: number;
			bytes: number;
			failed: { path: string; error: string }[];
	  }
	| { type: 'cancelled' }
	| { type: 'error'; message: string; code?: string; params?: Record<string, string | number> };

/** One entry of GET /api/system/python's `modules` array — one per import
 * name in ingest/requirements.txt (see pythonModules.ts). `name` is the
 * Python import name (e.g. "py_asciimath"), not the PyPI dist name. */
export interface PythonModuleStatus {
	name: string;
	installed: boolean;
}

/** Aşama 2b — GET /api/system/python's full response shape. `pythonInstalled`
 * and `markitdownInstalled` are kept for backward compat with any caller
 * that only read those two original fields; `modules`/`pandoc`/`pythonVersion`
 * are additions. `pandoc` is informational only — it's optional tooling
 * (convert.py degrades gracefully without it) and must never drive
 * PythonStatusBanner's missing-dependency state the way a missing module
 * does. */
export interface PythonSystemStatus {
	/** process.platform of the server — the banner words its install hint per OS. */
	platform: string;
	/** Set (with pythonInstalled false) when a Python was found but is < 3.10. */
	pythonProblem: { code: 'PYTHON_TOO_OLD'; params: { version: string } } | null;
	pythonInstalled: boolean;
	pythonVersion: string | null;
	markitdownInstalled: boolean;
	modules: PythonModuleStatus[];
	pandoc: boolean;
}

/** GET /api/study/errors (F2). Mirrors src/lib/server/learner-errors.ts's WeakSpot/ErrorItem — kept as a separate,
 * client-safe copy the same way LearnerProfile (learner-model.ts) is kept apart from the server's AnswerRow. */
export interface WeakSpotView {
	id: string;
	sourcePath: string;
	headingPath: string;
	noteName: string;
	domains: string[];
	openErrors: number;
	resolvedErrors: number;
	lapsedCards: number;
	forgottenCards: number;
	lastSeen: string;
	errors: WeakSpotErrorView[];
}

export interface WeakSpotErrorView {
	kind: 'quiz' | 'card';
	id: string;
	quizId?: string;
	type?: string;
	question: string;
	back?: string;
	confusion: { chose: string; correct: string } | null;
	modelFeedback?: string | null;
	wrongCount: number;
	resolved: boolean;
	lastAt: string;
}

/** GET/POST /api/memory, PATCH/DELETE /api/memory/[id] (F3). Mirrors src/lib/server/memory-store.ts's MemoryRow —
 * kept as a separate, client-safe copy, same pattern as WeakSpotView. */
export interface MemoryNoteView {
	id: string;
	type: 'GLOBAL' | 'PERSONAL';
	domain: string | null;
	value: string;
	createdAt: string;
}

/** GET /api/providers response shape — settings/providers page's model. */
export interface ProviderStatus {
	id: string;
	label: string;
	kind: 'ollama' | 'openai-compat' | 'anthropic' | 'azure-openai';
	baseUrl: string;
	enabled: boolean;
	/** Problem A — true for Ollama and for an openai-compat provider the user marked "yerel sunucu". Drives
	 * the settings page's local/cloud badge and whether the "yerel sunucu" checkbox is shown/checked; see
	 * config-store.ts's isCloud() (`!local` is exactly its local-openai-compat half). */
	local: boolean;
	needsKey: boolean;
	keyStatus: 'connected' | 'none';
	mask: string | null;
	/** Model this provider is asked for when the fallback chain reaches it
	 * without an explicit pin — see registry.ts's resolveHopModel. null means
	 * unset, so this provider gets skipped rather than asked for a wrong
	 * model on that path. */
	defaultModel: string | null;
	/** Aşama 3c — set on whichever provider is actually CONFIGURED for
	 * embedding right now (GET /api/embedding, providers/config-store.ts's
	 * `embedding` block), not hardcoded to 'ollama' any more: embedding can
	 * be a local/cloud openai-compat provider instead. Every other provider
	 * gets null. Still what LocalServerBanner's "is the required model
	 * pulled?" check reads when embedding happens to be on Ollama — never
	 * hardcodes a model name that could drift from the real one (see
	 * KURULUM-REHBERI.md's nomic-embed-text/bge-m3 mixup this originally
	 * existed to prevent). */
	embedModel: string | null;
	/** 'live' = read straight off this provider's own rate-limit response
	 * headers (Groq/Mistral send these on every response — see
	 * registry.ts's getRateLimitInfo). 'log' = no such headers exist for
	 * this provider (Gemini/OpenRouter only send them on a 429 itself), so
	 * this is a fallback event recorded in app-log.jsonl instead — weaker
	 * signal, just "when was this last rate-limited", not "how close is it
	 * now". null = neither exists yet for this provider. */
	rateLimit: {
		source: 'live' | 'log';
		remainingRequests?: number;
		limitRequests?: number;
		resetRequestsAt?: string;
		remainingTokens?: number;
		limitTokens?: number;
		resetTokensAt?: string;
		lastHitAt?: string;
	} | null;
}

/** GET /api/providers/[id]/models (F14-4) response shape — settings page's "model listesini yönet" checkbox
 * list. `enabled` reflects the provider's enabledModels allow-list (true for everything when uncurated). */
export interface ModelListItem {
	id: string;
	enabled: boolean;
	/** Aşama 4b — effective capability flags (family table with the provider's override applied). */
	caps: { tools: boolean; reasoning: boolean };
	/** Aşama 4b — the user's explicit per-model override, when one is set. */
	capsOverride?: { tools?: boolean; reasoning?: boolean };
}

/** GET /api/providers/models response shape — chat header's per-chat
 * model/provider override selector. */
export interface ProviderModelOption {
	providerId: string;
	providerLabel: string;
	id: string;
	ctx: number;
	caps: { tools: boolean; reasoning: boolean };
	/** İ2 (Aşama 8) — false for Ollama (local, nothing ever leaves the
	 * device); true for any cloud provider (config-store.ts's isCloud()).
	 * ModelPickerRow/GenerationDialog gate switching onto a cloud option
	 * with `consented: false` behind a first-use confirmation instead of
	 * sending the request and relying on chat-fallback.ts's server-side
	 * backstop to silently reroute it. */
	cloud: boolean;
	/** Always true when `cloud` is false. For a cloud option, whether the
	 * user has already granted provider-consent.ts's "remember my choice" —
	 * see the doc comment on `cloud` above. */
	consented: boolean;
}

// ---------------------------------------------------------------------------
// Aşama 2b — Tauri local-server launcher commands (src-tauri/src/launchers.rs
// and winget.rs). These are the JS-side mirrors of the #[tauri::command]
// return/serde shapes; the Rust structs have NO `rename_all`, so field names
// serialize verbatim as snake_case (unlike Tauri's own automatic command
// ARGUMENT camelCasing — see save_launcher's call sites for that half).
// ---------------------------------------------------------------------------

/** invoke('detect_local_servers') — one entry per catalog id, always
 * present regardless of install state. `installed` is the resolved program
 * path (or a WSL identifier for vllm) when found, else null. `running` is a
 * loopback HTTP probe on the kind's default port — never influenced by a
 * launcher's saved (possibly hand-edited) config. `identifiedAs` is set only
 * when `running` is true, and can legitimately differ from `id` if whatever
 * is answering on that port isn't actually this kind. */
export interface DetectedServer {
	id: string;
	display_name: string;
	port: number;
	launchable: boolean;
	winget_id: string | null;
	download_url: string;
	installed: string | null;
	running: boolean;
	identified_as: string | null;
}

/** invoke('list_launchers') entries / the shape save_launcher's own params
 * persist — `model_path`/`model` are omitted by serde when unset (never
 * `null` on the wire), so both come back as `undefined` here, not `null`.
 * IMPORTANT: unlike `args` (whose save_launcher param is `Option` with
 * "None = leave unchanged" semantics), `model_path`/`model` are NOT
 * preserve-if-omitted on the Rust side — save_launcher always overwrites
 * both to whatever it's given. Any caller that saves other fields (port,
 * auto_start, args) on an existing launcher must pass its CURRENT
 * model_path/model back through, or it will silently clear them. */
export interface LauncherConfig {
	id: string;
	program: string;
	args: string[];
	port: number;
	auto_start: boolean;
	model_path?: string;
	model?: string;
}

/** invoke('launcher_status', { id }) result. */
export type LauncherStatusValue = 'running_ours' | 'running_external' | 'stopped';

/** 'winget-progress' event payload (see winget.rs's WingetProgress). */
export interface WingetProgressEvent {
	id: string;
	line: string;
}

/** 'winget-done' event payload (see winget.rs's WingetDone — `exitCode` is
 * the one field on this side of the boundary that DOES get an explicit
 * `#[serde(rename)]`, hence camelCase here unlike DetectedServer/LauncherConfig
 * above). */
export interface WingetDoneEvent {
	id: string;
	success: boolean;
	exitCode: number | null;
}
