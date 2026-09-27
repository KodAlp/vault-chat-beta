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
	reason?: 'unindexed' | 'no-embedding-match' | 'filtered' | 'scope' | 'small-talk';
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
	/** Hedge/uncertainty phrases detected in this message's reasoning trace (when there was one) and its
	 * final answer text (always) — see $lib/server/hallucination.ts. Empty/absent means none found. */
	hedges?: string[];
	/** F8 — true when some model call this turn came close to the context window (see history-limits.ts /
	 * env.ts's serveCtxOverride). Client-only, never persisted — same footing as narrowScope/smallTalk. */
	nearCtxLimit?: boolean;
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
	| { type: 'done'; sources: RetrievedChunk[]; narrowScope?: boolean; smallTalk?: boolean; hedges?: string[]; nearCtxLimit?: boolean }
	| { type: 'error'; message: string; code?: string; params?: Record<string, string | number> }
	/** A U+FFFD (corrupted-output) retry is starting — the client must
	 * discard whatever partial content/thinking it already rendered for
	 * this message before further `delta`/`thinking` events arrive, since
	 * the server is regenerating from scratch. See api/chat/+server.ts's
	 * corruption-retry loop. */
	| { type: 'regenerate' };

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
}

/** VaultRecord plus a computed, non-persisted field — api/vaults/+server.ts
 * and +page.server.ts both add this via retrieve.ts's countUnindexedFiles();
 * it never lives in vaults.json itself (see api/vaults/+server.ts's doc
 * comment). Files on disk that `npm run index` would walk but hasn't yet —
 * a curation pass that finished without a following reindex looked, before
 * this existed, identical to a vault with nothing new (E2). */
export interface VaultWithStatus extends VaultRecord {
	unindexedCount: number;
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

/** SSE event shapes streamed by POST /api/library/import-obsidian. */
export type ObsidianImportEvent =
	| { type: 'progress'; stage: string; fileName?: string }
	| { type: 'item'; item: ImportResultItem }
	| { type: 'done'; summary: ImportSummary }
	| { type: 'error'; message: string; code?: string; params?: Record<string, string | number> };

/** SSE event shapes streamed by POST /api/system/python (pip install run). */
export type PythonSetupEvent =
	| { type: 'log'; line: string }
	| { type: 'done'; ok: boolean }
	| { type: 'error'; message: string; code?: string; params?: Record<string, string | number> };

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
	kind: 'ollama' | 'openai-compat' | 'anthropic';
	baseUrl: string;
	enabled: boolean;
	needsKey: boolean;
	keyStatus: 'connected' | 'none';
	mask: string | null;
	/** Model this provider is asked for when the fallback chain reaches it
	 * without an explicit pin — see registry.ts's resolveHopModel. null means
	 * unset, so this provider gets skipped rather than asked for a wrong
	 * model on that path. */
	defaultModel: string | null;
	/** Only set on the 'ollama' entry — embedding always runs through Ollama
	 * regardless of which provider handles chat, so this isn't a per-
	 * provider concept. Sourced from embed-config.ts's EMBED_MODEL so a
	 * client-side "is the required model pulled?" check never hardcodes a
	 * model name that could drift from the real one (see
	 * KURULUM-REHBERI.md's nomic-embed-text/bge-m3 mixup this is meant to
	 * prevent from recurring). */
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
