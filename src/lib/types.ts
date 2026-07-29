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

export type ChatRole = 'user' | 'assistant';

export interface ChatMessage {
	id: string;
	role: ChatRole;
	content: string;
	thinking?: string;
	sources?: RetrievedChunk[];
	interrupted?: boolean;
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
}

export interface OllamaModel {
	name: string;
	size: number;
	modified_at: string;
}

/** Client-safe mirror of chats-db.ts's ChatRow — that module is server-only
 * ($lib/server/), can't be imported from a component. Kept structurally
 * identical to what GET /api/chats actually returns. */
export interface ChatSummary {
	id: string;
	title: string | null;
	model: string;
	created_at: string;
	updated_at: string;
}

/** SSE event shapes streamed by POST /api/chat. */
export type StreamEvent =
	| { type: 'chatId'; chatId: string }
	| { type: 'delta'; content: string }
	| { type: 'thinking'; content: string }
	| { type: 'done'; sources: RetrievedChunk[] }
	| { type: 'error'; message: string };

export interface QuizGenerationRequest {
	domains?: string[];
	chatId?: string;
	prompt: string;
	composition: { mc: number; tf: number; open: number };
	model: string;
}

/** SSE event shapes streamed by POST /api/generate/quiz. */
export type QuizGenerationEvent =
	| { type: 'progress'; stage: 'retrieving' | 'generating' | 'validating' | 'retrying' }
	| { type: 'done'; quizId: string }
	| { type: 'error'; message: string };

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
}

/** SSE event shapes streamed by POST /api/generate/cards. */
export type CardGenerationEvent =
	| { type: 'progress'; stage: 'retrieving' | 'generating' | 'validating' | 'retrying' }
	| { type: 'done'; deckId: string }
	| { type: 'error'; message: string };

export type Grade = 'again' | 'hard' | 'good' | 'easy';

export interface CardView {
	id: string;
	front: string;
	back: string;
	source_path: string;
	heading_path: string;
}

export type UserSkillScope = 'chat' | 'quiz' | 'flashcards';

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
