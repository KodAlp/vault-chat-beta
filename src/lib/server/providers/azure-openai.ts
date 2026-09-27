import { OpenAICompatAdapter } from './openai-compat';

/**
 * Problem D — Azure OpenAI. Verified against Microsoft's docs (2026-05): the Azure OpenAI "v1 API" surface at
 * `https://<resource>.openai.azure.com/openai/v1` (or `https://<resource>.services.ai.azure.com/openai/v1`)
 * is otherwise wire-compatible with the plain OpenAI /chat/completions and /models endpoints this app already
 * speaks through OpenAICompatAdapter — no api-version query param needed on that surface — with exactly one
 * difference: authentication is a plain `api-key` header, never `Authorization: Bearer`. Everything else
 * (chatUrl, streaming SSE parsing, timeouts, error classification, extraBody) is inherited unchanged.
 *
 * The `model` field in the chat request body is the user's own Azure DEPLOYMENT name, not a public model id —
 * Azure's /models surface is not documented to list deployments, so a deployment is never discoverable via
 * listModels() the way a normal OpenAI-compatible model is. The settings UI's "model listesini yönet" pinned-
 * models feature (problem B, see model-filter.ts's pickerModels) is how the user adds a deployment name to
 * the pickers by hand.
 */
export class AzureOpenAIAdapter extends OpenAICompatAdapter {
	protected headers(): Record<string, string> {
		const h: Record<string, string> = { 'content-type': 'application/json' };
		if (this.config.apiKey) h['api-key'] = this.config.apiKey;
		return h;
	}
}
