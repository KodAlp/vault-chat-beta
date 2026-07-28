import { env } from '$env/dynamic/private';

const OLLAMA_URL = env.OLLAMA_URL ?? 'http://localhost:11434';

export interface OllamaChatMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

export interface OllamaModelInfo {
	name: string;
	size: number;
	modified_at: string;
}

export async function listModels(): Promise<OllamaModelInfo[]> {
	const res = await fetch(`${OLLAMA_URL}/api/tags`);
	if (!res.ok) throw new Error(`Ollama /api/tags ${res.status}`);
	const data = (await res.json()) as { models?: OllamaModelInfo[] };
	return data.models ?? [];
}

export async function embed(texts: string[], model: string): Promise<number[][]> {
	const res = await fetch(`${OLLAMA_URL}/api/embed`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ model, input: texts })
	});
	if (!res.ok) throw new Error(`Ollama /api/embed ${res.status}`);
	const data = (await res.json()) as { embeddings: number[][] };
	return data.embeddings;
}

export interface StreamPiece {
	kind: 'content' | 'thinking';
	text: string;
}

/**
 * Streams assistant content (and, when `think` is on, reasoning) from Ollama's
 * native /api/chat (NDJSON), not the OpenAI-compat shim — native exposes
 * keep_alive, `think`, and cleaner stream framing.
 *
 * Thinking-capable models (qwen3) default to thinking ON even when `think` is
 * omitted, and stream it in a separate `message.thinking` field — content stays
 * empty until the whole reasoning phase finishes. Pass `think: false` for fast
 * answers with no visible reasoning phase.
 */
export async function* streamChat(
	model: string,
	messages: OllamaChatMessage[],
	think: boolean
): AsyncGenerator<StreamPiece> {
	let res: Response;
	try {
		res = await fetch(`${OLLAMA_URL}/api/chat`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ model, messages, stream: true, keep_alive: '10m', think })
		});
	} catch {
		throw new Error('Ollama sunucusuna ulaşılamadı — "ollama serve" çalışıyor mu?');
	}
	if (!res.ok || !res.body) {
		throw new Error(`Ollama sunucusuna ulaşılamadı — "ollama serve" çalışıyor mu? (${res.status})`);
	}

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split('\n');
		buffer = lines.pop() ?? '';
		for (const line of lines) {
			if (!line.trim()) continue;
			const chunk = JSON.parse(line) as {
				message?: { content?: string; thinking?: string };
				done?: boolean;
			};
			if (chunk.message?.thinking) yield { kind: 'thinking', text: chunk.message.thinking };
			if (chunk.message?.content) yield { kind: 'content', text: chunk.message.content };
			if (chunk.done) return;
		}
	}
}
