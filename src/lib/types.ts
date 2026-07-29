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
}

export interface ChatRequestBody {
	messages: ChatMessage[];
	model: string;
	domains?: string[];
	think?: boolean;
}

export interface OllamaModel {
	name: string;
	size: number;
	modified_at: string;
}

/** SSE event shapes streamed by POST /api/chat. */
export type StreamEvent =
	| { type: 'delta'; content: string }
	| { type: 'thinking'; content: string }
	| { type: 'done'; sources: RetrievedChunk[] }
	| { type: 'error'; message: string };
