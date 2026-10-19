/**
 * System-under-test (SUT) runner for the generation benchmark
 * (bench/run-generation.ts) — reproduces what src/routes/api/chat/+server.ts
 * actually does for one turn: retrieve() -> buildPromptMessages() -> a
 * streamed Ollama /api/chat call, with per-stage timings and Ollama's own
 * `done` stats.
 *
 * Deliberately NOT the real chat route: no chats.db, no SSE framing, no
 * corruption-retry loop, no tool round-trips, no fallback chain — see
 * run-generation.ts's printed `deviations` list for the ones the build
 * brief called out explicitly. This module owns the isolation guarantees
 * (CHAT_MEMORY_GATE=0 + an empty SKILLS_DIR) since every caller needs them.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { retrieve } from '../../src/lib/server/retrieve';
import { buildRetrievalQuery } from '../../src/lib/server/retrieval-query';
import { buildPromptMessages, type ResponseLanguageMode } from '../../src/lib/server/prompt';
import { chatRetrievalK } from '../../src/lib/server/env';
// Dev-tooling default only — the app itself reads the Ollama provider's baseUrl from providers.json.
const prodOllamaUrl = (): string => process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
import type { VaultContext } from '../../src/lib/server/vaults';
import type { ChatMessage, RetrievedChunk } from '../../src/lib/types';
import { chunkAnchor } from './anchor';

/**
 * Isolation setup shared by every SUT call in a run — CHAT_MEMORY_GATE='0'
 * short-circuits computeMemoryBlock() before it ever opens chats.db (same
 * kill switch scripts/eval-prompt-injection.ts uses), and an empty SKILLS_DIR
 * means renderUserSkillsBlock() finds nothing to read. Idempotent — safe to
 * call once per process at the top of run-generation.ts.
 */
export function setupIsolation(): void {
	process.env.CHAT_MEMORY_GATE = '0';
	if (!process.env.SKILLS_DIR) {
		process.env.SKILLS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-gen-skills-'));
	}
}

export interface SutContext {
	v: VaultContext;
	model: string;
	ollamaUrl: string;
	allowedLanguages: string[];
	responseLanguage: ResponseLanguageMode;
	/** What options.num_ctx to request — mirrors providers/ollama.ts's
	 * serveCtxFor() table for qwen3 (8192) without importing that private
	 * function. See run-generation.ts's `deviations` list. */
	numCtx: number;
	think: boolean;
	/** Resource sampling interval in ms during generation (spec: 500ms). */
	sampleIntervalMs?: number;
	/** Production path with the chat reranker (providers.json is never touched; run-generation.ts --rerank or VC_RERANK=1):
	 * retrieve(..., { rerank: true }) and, like the chat route, the no-relevant-sources notice on 'rerank-no-match'. */
	rerank?: boolean;
}

export interface SutItemInput {
	question: string;
	turns?: { role: 'user' | 'assistant'; content: string }[];
}

export interface ResourceSample {
	tMs: number;
	gpuMemUsedMb?: number;
	gpuUtilPct?: number;
	rssMb: number;
}

export interface OllamaStats {
	promptEvalCount?: number;
	promptEvalDurationNs?: number;
	evalCount?: number;
	evalDurationNs?: number;
	loadDurationNs?: number;
	tokPerSec?: number;
}

export interface SutChunkOut {
	anchor: string;
	path: string;
	heading_path: string;
	topic: string;
	depth: string;
	text: string;
}

export interface SutResult {
	answer: string;
	thinking: string;
	chunks: SutChunkOut[];
	retrieval: {
		reason?: string;
		keyword?: boolean;
		bestDistance?: number;
		rerankBest?: number;
		narrowScope: boolean;
		smallTalk?: boolean;
	};
	timings: {
		retrievalMs: number;
		promptBuildMs: number;
		ttftMs?: number;
		generationMs: number;
		totalMs: number;
	};
	ollamaStats: OllamaStats;
	resourceSamples: ResourceSample[];
	error?: string;
}

function toChatMessages(item: SutItemInput): ChatMessage[] {
	const turns = item.turns ?? [];
	const messages: ChatMessage[] = turns.map((t, i) => ({ id: `turn-${i}`, role: t.role, content: t.content }));
	messages.push({ id: 'question', role: 'user', content: item.question });
	return messages;
}

/** Best-effort GPU sample via `nvidia-smi` — absent on a machine with no
 * NVIDIA GPU or driver, in which case samples just carry rssMb. Never throws. */
function sampleGpu(): Promise<{ gpuMemUsedMb?: number; gpuUtilPct?: number }> {
	return new Promise((resolve) => {
		execFile(
			'nvidia-smi',
			['--query-gpu=memory.used,utilization.gpu', '--format=csv,noheader,nounits'],
			{ timeout: 2000 },
			(err, stdout) => {
				if (err || !stdout) return resolve({});
				const line = stdout.trim().split('\n')[0];
				const [mem, util] = line.split(',').map((s) => Number(s.trim()));
				resolve({
					gpuMemUsedMb: Number.isFinite(mem) ? mem : undefined,
					gpuUtilPct: Number.isFinite(util) ? util : undefined
				});
			}
		);
	});
}

export function defaultSutContext(v: VaultContext, model: string, opts: Partial<SutContext> = {}): SutContext {
	return {
		v,
		model,
		ollamaUrl: opts.ollamaUrl ?? prodOllamaUrl(),
		allowedLanguages: opts.allowedLanguages ?? ['Türkçe'],
		responseLanguage: opts.responseLanguage ?? 'match',
		numCtx: opts.numCtx ?? 8192,
		think: opts.think ?? false,
		sampleIntervalMs: opts.sampleIntervalMs ?? 500,
		rerank: opts.rerank ?? process.env.VC_RERANK === '1'
	};
}

/**
 * Runs one item through retrieval + prompt build + a real streamed Ollama
 * /api/chat call — mirrors api/chat/+server.ts's request shape (native
 * /api/chat, options.num_ctx, think, no temperature) but talks to Ollama
 * directly instead of through the provider registry/fallback chain.
 */
export async function runSut(ctx: SutContext, item: SutItemInput): Promise<SutResult> {
	setupIsolation();
	const totalStart = Date.now();

	const messages = toChatMessages(item);
	const query = buildRetrievalQuery(messages);

	const retrievalStart = Date.now();
	const result = await retrieve(ctx.v, query, {
		k: chatRetrievalK(),
		keywordFallback: true,
		keywordQuery: item.question,
		rerank: ctx.rerank === true
		// smallTalkGate intentionally omitted — see this module's doc comment
		// and run-generation.ts's printed deviations list.
	});
	const retrievalMs = Date.now() - retrievalStart;

	const promptBuildStart = Date.now();
	const promptMessages = await buildPromptMessages(messages, result.chunks, ctx.allowedLanguages, ctx.v, 'free_chat', {
		responseLanguage: ctx.responseLanguage,
		noRelevantSources: result.reason === 'rerank-no-match'
	});
	const promptBuildMs = Date.now() - promptBuildStart;

	const chunksOut: SutChunkOut[] = result.chunks.map((c: RetrievedChunk) => ({
		anchor: chunkAnchor(c),
		path: c.path,
		heading_path: c.heading_path,
		topic: c.topic,
		depth: c.depth,
		text: c.display_text
	}));

	const resourceSamples: ResourceSample[] = [];
	let sampler: ReturnType<typeof setInterval> | null = null;
	const genStart = Date.now();
	const startSampling = () => {
		sampler = setInterval(() => {
			void sampleGpu().then((gpu) => {
				resourceSamples.push({
					tMs: Date.now() - genStart,
					gpuMemUsedMb: gpu.gpuMemUsedMb,
					gpuUtilPct: gpu.gpuUtilPct,
					rssMb: process.memoryUsage().rss / (1024 * 1024)
				});
			});
		}, ctx.sampleIntervalMs ?? 500);
	};
	const stopSampling = () => {
		if (sampler) clearInterval(sampler);
		sampler = null;
	};

	let answer = '';
	let thinking = '';
	let ttftMs: number | undefined;
	const stats: OllamaStats = {};
	let errorMsg: string | undefined;

	try {
		startSampling();
		const res = await fetch(`${ctx.ollamaUrl}/api/chat`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				model: ctx.model,
				messages: promptMessages.map((m) => ({ role: m.role, content: m.content })),
				stream: true,
				think: ctx.think,
				options: { num_ctx: ctx.numCtx }
			})
		});
		if (!res.ok || !res.body) {
			errorMsg = `Ollama HTTP ${res.status}: ${await res.text().catch(() => '')}`;
		} else {
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
					const trimmed = line.trim();
					if (!trimmed) continue;
					let json: {
						message?: { content?: string; thinking?: string };
						done?: boolean;
						prompt_eval_count?: number;
						prompt_eval_duration?: number;
						eval_count?: number;
						eval_duration?: number;
						load_duration?: number;
					};
					try {
						json = JSON.parse(trimmed);
					} catch {
						continue;
					}
					if (json.message?.thinking) thinking += json.message.thinking;
					if (json.message?.content) {
						if (ttftMs === undefined) ttftMs = Date.now() - genStart;
						answer += json.message.content;
					}
					if (json.done) {
						stats.promptEvalCount = json.prompt_eval_count;
						stats.promptEvalDurationNs = json.prompt_eval_duration;
						stats.evalCount = json.eval_count;
						stats.evalDurationNs = json.eval_duration;
						stats.loadDurationNs = json.load_duration;
						if (json.eval_count !== undefined && json.eval_duration) {
							stats.tokPerSec = json.eval_count / (json.eval_duration / 1e9);
						}
					}
				}
			}
		}
	} catch (err) {
		errorMsg = err instanceof Error ? err.message : String(err);
	} finally {
		stopSampling();
	}

	const generationMs = Date.now() - genStart;
	const totalMs = Date.now() - totalStart;

	return {
		answer,
		thinking,
		chunks: chunksOut,
		retrieval: {
			reason: result.reason,
			keyword: result.keyword,
			bestDistance: result.bestDistance,
			rerankBest: result.rerankBest,
			narrowScope: result.narrowScope,
			smallTalk: result.smallTalk
		},
		timings: { retrievalMs, promptBuildMs, ttftMs, generationMs, totalMs },
		ollamaStats: stats,
		resourceSamples,
		error: errorMsg
	};
}
