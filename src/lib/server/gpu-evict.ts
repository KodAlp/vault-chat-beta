import { getOllamaProviderId } from './providers/config-store';
import { ollamaGate } from './providers/ollama-gate';

export interface GpuEvictDeps {
	getOllamaProviderId: () => string | null;
	evictAll: () => Promise<void>;
}

const defaultDeps: GpuEvictDeps = {
	getOllamaProviderId,
	evictAll: () => ollamaGate.evictAllForExclusiveJob()
};

/**
 * Frees the GPU for an exclusive job (batch import's docling run), but only
 * when an enabled Ollama provider is actually configured — otherwise there is
 * nothing of ours to unload and the call would just poke a dead localhost
 * port. Returns whether an eviction was attempted.
 *
 * Other local OpenAI-compatible servers (LM Studio, llama.cpp, vLLM) have no
 * generic unload API, so their models are NOT evicted.
 *
 * Must be called while holding a sharedJobMutex slot (run() or runShared();
 * see ollamaGate.evictAllForExclusiveJob for why a shared slot is enough and
 * why concurrent calls from parallel conversions are harmless). Lives here rather than in
 * convertQueue.ts so the decision is unit-testable without that module's
 * python/pandoc/env imports.
 */
export async function evictForExclusiveJob(deps: GpuEvictDeps = defaultDeps): Promise<boolean> {
	if (deps.getOllamaProviderId() === null) return false;
	await deps.evictAll();
	return true;
}
