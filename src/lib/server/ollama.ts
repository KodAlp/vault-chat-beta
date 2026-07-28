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

/**
 * Streams assistant content deltas from Ollama's native /api/chat (NDJSON),
 * not the OpenAI-compat shim — native exposes keep_alive and cleaner stream framing.
 */
export async function* streamChat(
	model: string,
	messages: OllamaChatMessage[]
): AsyncGenerator<string> {
	let res: Response;
	try {
		res = await fetch(`${OLLAMA_URL}/api/chat`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ model, messages, stream: true, keep_alive: '10m' })
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
				message?: { content?: string };
				done?: boolean;
			};
			if (chunk.message?.content) yield chunk.message.content;
			if (chunk.done) return;
		}
	}
}
