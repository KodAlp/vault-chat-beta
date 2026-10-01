/**
 * Aşama 4d — which state the app-wide banner (LocalServerBanner.svelte) should be in, decided purely from data
 * the client already loads (GET /api/providers, GET /api/providers/chains, the settings pins) so it is
 * unit-testable. Replaces OllamaStatusBanner's hardcoded "provider id is ollama".
 */
export interface BannerProvider {
	id: string;
	label: string;
	kind: 'ollama' | 'openai-compat' | 'anthropic' | 'azure-openai';
	enabled: boolean;
	/** ProviderStatus.local — already folds "kind === 'ollama'" and "openai-compat marked local" together. */
	local: boolean;
	baseUrl: string;
}

export type BannerTarget =
	| { state: 'setup' }
	| { state: 'local'; provider: BannerProvider }
	| { state: 'none' };

/**
 * The provider a chat request will actually go to, mirroring the server's routing: the client pin when it is
 * set and names an enabled provider, else the first enabled provider of the chat chain.
 *  - nothing resolves (chain empty / all disabled, no usable pin) -> 'setup' (chatWithFallback would throw
 *    CHAT_NO_CHAIN): "setup not finished";
 *  - resolves to a local provider (kind ollama or marked local) -> 'local': probe it, warn when it is down;
 *  - resolves to a cloud provider -> 'none': no band, no polling.
 */
export function resolveBannerTarget(input: {
	pins: readonly string[];
	providers: readonly BannerProvider[];
	chatChain: readonly string[];
}): BannerTarget {
	const enabled = new Map(input.providers.filter((p) => p.enabled).map((p) => [p.id, p]));
	const pinned = input.pins.find((id) => id !== '' && enabled.has(id));
	const effectiveId = pinned ?? input.chatChain.find((id) => enabled.has(id));
	if (effectiveId === undefined) return { state: 'setup' };
	const provider = enabled.get(effectiveId)!;
	return provider.local ? { state: 'local', provider } : { state: 'none' };
}

/** Which Tauri launcher id can start this provider's server: the 'ollama' launcher for an Ollama-kind
 * provider, otherwise the launcher configured on the same port as the provider's baseUrl (the wizard created
 * the provider as http://127.0.0.1:<port>/v1 from that launcher). Null = nothing to offer a Start button for. */
export function findLauncherId(provider: Pick<BannerProvider, 'kind' | 'baseUrl'>, launchers: readonly { id: string; port: number }[]): string | null {
	if (provider.kind === 'ollama') return launchers.find((l) => l.id === 'ollama')?.id ?? null;
	let port: number;
	try {
		const url = new URL(provider.baseUrl);
		port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
	} catch {
		return null;
	}
	return launchers.find((l) => l.port === port)?.id ?? null;
}
