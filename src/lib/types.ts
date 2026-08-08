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
	distance: number;
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
	 * message streamed in. Rendered as a system aside, not assistant prose. */
	notices?: string[];
	/** Mirrors RetrieveResult.narrowScope for this message's answer — set
	 * when retrieve() found relevant chunks but a scope filter excluded all
	 * of them. Drives Message.svelte's "kapsamı genişlet?" suggestion. */
	narrowScope?: boolean;
	/** Hedge/uncertainty phrases detected in this message's `thinking` text
	 * (see $lib/server/hallucination.ts) — only ever populated when the
	 * message was generated with think mode on. Empty/absent means no
	 * signal, not "checked and clean" vs "never checked" — think-mode-off
	 * messages simply never run detection. */
	hedges?: string[];
}

export interface ChatRequestBody {
	messages: ChatMessage[];
	model: string;
	domains?: string[];
	think?: boolean;
	chatId?: string;
	/** Model for background title generation on a new chat — settings.defaultModel
	 * client-side. Falls back server-side if omitted. */
	titleModel?: string;
	/** Vault id — omitted in Faz 8 (single active-vault UI), sent by Faz 9's
	 * vault-aware chat header. Server falls back to the active vault. */
	vault?: string;
	/** Tri-state source-tree selection (Faz 9 UI) — omitted means "all". */
	includedPaths?: string[];
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
	| { type: 'notice'; message: string }
	| { type: 'done'; sources: RetrievedChunk[]; narrowScope?: boolean; hedges?: string[] }
	| { type: 'error'; message: string }
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
	vault?: string;
	/** Tri-state source-tree selection (same field/semantics as
	 * ChatRequestBody.includedPaths) — omitted means "all". */
	includedPaths?: string[];
}

/** SSE event shapes streamed by POST /api/generate/quiz. `narrowScope` on
 * the error event mirrors RetrieveResult.narrowScope — set when relevant
 * chunks exist but includedPaths filtered them all out, so the UI can
 * offer "kapsamı genişlet?" instead of a flat "no sources" message. */
export type QuizGenerationEvent =
	| { type: 'progress'; stage: 'retrieving' | 'generating' | 'validating' | 'retrying' }
	| { type: 'done'; quizId: string }
	| { type: 'error'; message: string; narrowScope?: boolean };

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
	vault?: string;
	includedPaths?: string[];
}

/** SSE event shapes streamed by POST /api/generate/cards. */
export type CardGenerationEvent =
	| { type: 'progress'; stage: 'retrieving' | 'generating' | 'validating' | 'retrying' }
	| { type: 'done'; deckId: string }
	| { type: 'error'; message: string; narrowScope?: boolean };

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
	vault?: string;
	includedPaths?: string[];
}

/** SSE event shapes streamed by POST /api/generate/report. */
export type ReportGenerationEvent =
	| { type: 'progress'; stage: 'retrieving' | 'generating' | 'validating' | 'retrying' }
	| { type: 'done'; reportId: string }
	| { type: 'error'; message: string; narrowScope?: boolean };

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
	| { type: 'error'; message: string; narrowScope?: boolean };

export interface MindMapView {
	id: string;
	title: string;
	model: string;
}

export interface MindMapNodeView {
	id: string;
	path: string[];
	source_path: string;
	heading_path: string;
}

export interface SlidesGenerationRequest {
	domains?: string[];
	chatId?: string;
	prompt: string;
	model: string;
	vault?: string;
	includedPaths?: string[];
}

/** SSE event shapes streamed by POST /api/generate/slides. Terminal field is
 * `slideDeckId`, not `deckId` — cards already owns a `decks` table and
 * `CardGenerationEvent.deckId`; reusing that name here would silently read
 * as a card-deck reference at every call site. */
export type SlidesGenerationEvent =
	| { type: 'progress'; stage: 'retrieving' | 'generating' | 'validating' | 'retrying' }
	| { type: 'done'; slideDeckId: string }
	| { type: 'error'; message: string; narrowScope?: boolean };

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
	content_markdown: string;
	source_path: string;
}

export type UserSkillScope = 'chat' | 'quiz' | 'flashcards' | 'mindmap' | 'report' | 'slides';

export interface UserSkillStatus {
	name: string;
	/** Path relative to data/skills/, e.g. "_examples/notation-preference.md". */
	relPath: string;
	description: string | null;
	scope: 'all' | UserSkillScope[];
	enabled: boolean;
	priority: number;
	charCount: number;
	truncated: boolean;
	parseError: string | null;
}

/** Client-safe mirror of vaults.ts's VaultRecord — that module is server-only
 * ($lib/server/), can't be imported from a component. */
export interface VaultRecord {
	id: string;
	name: string;
	path: string;
	createdAt: string;
	lastOpenedAt: string;
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
}

export type ImportResultStatus = 'converted' | 'skipped' | 'needs_review' | 'failed';

export interface ImportResultItem {
	fileName: string;
	status: ImportResultStatus;
	reason?: string;
	path?: string;
}

export interface ImportSummary {
	items: ImportResultItem[];
}

/** SSE event shapes streamed by POST /api/import and /api/import/batch. */
export type ImportEvent =
	| { type: 'progress'; stage: string; fileName?: string }
	| { type: 'ready'; importId: string; proposed: { title: string; domain: string; level: string }; warnings: string[] }
	| { type: 'item'; item: ImportResultItem }
	| { type: 'done'; summary?: ImportSummary }
	| { type: 'error'; message: string };

/** SSE event shapes streamed by POST /api/library/import-obsidian. */
export type ObsidianImportEvent =
	| { type: 'progress'; stage: string; fileName?: string }
	| { type: 'item'; item: ImportResultItem }
	| { type: 'done'; summary: ImportSummary }
	| { type: 'error'; message: string };

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
}

/** GET /api/providers/models response shape — chat header's per-chat
 * model/provider override selector. */
export interface ProviderModelOption {
	providerId: string;
	providerLabel: string;
	id: string;
	ctx: number;
	caps: { tools: boolean; reasoning: boolean };
}
