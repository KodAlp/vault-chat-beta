import { ProviderError } from './types';
import { isCloud, type ProviderConfigEntry } from './config-store';

/**
 * Aşama 4d — replaces the chat route's "providerId === 'ollama'" special case. A local server (an
 * Ollama-kind provider, or an openai-compat one the user marked `local`) that cannot be connected to is the
 * single most likely failure of this product, and its actionable message ("is the local server running?")
 * is better than the generic PROVIDER_NETWORK / PROVIDER_TIMEOUT_CONNECT sentence. Returns the provider's
 * label when `err` is exactly that failure, else null (cloud providers keep the generic message, since a
 * cloud outage is not something the user can start).
 */
export function unreachableLocalServerLabel(
	err: unknown,
	entries: ReadonlyArray<Pick<ProviderConfigEntry, 'id' | 'label' | 'kind' | 'local'>>
): string | null {
	if (!(err instanceof ProviderError)) return null;
	if (err.kind !== 'network' && err.kind !== 'timeout_connect') return null;
	const entry = entries.find((e) => e.id === err.providerId);
	if (!entry || isCloud(entry)) return null;
	return entry.label;
}
