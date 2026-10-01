/**
 * Aşama 4c — clears a saved model/provider pick whose provider is gone. Saved settings (localStorage or the
 * server's ui-prefs.json) can point at a provider that has since been deleted or disabled; sending that pin
 * makes chat-fallback drop it with a notice on every request. Clearing the pair instead sends no pin, so
 * the server uses the task chain's head with its own default model.
 *
 * Pure (no $state, no fetch) so it is unit-testable; +layout.ts applies the returned patch.
 */
export interface PinFields {
	defaultModel: string;
	fastModel: string;
	reasoningModel: string;
	defaultProvider: string;
	fastProvider: string;
	reasoningProvider: string;
}

const PAIRS = [
	['defaultProvider', 'defaultModel'],
	['fastProvider', 'fastModel'],
	['reasoningProvider', 'reasoningModel']
] as const;

/** A patch (possibly empty) that blanks every provider/model pair whose provider is non-empty but not in
 * `usableProviderIds` (the ids of enabled providers). A blank provider is already "no pin" and is left alone. */
export function stalePinPatch(pins: PinFields, usableProviderIds: ReadonlySet<string>): Partial<PinFields> {
	const patch: Partial<PinFields> = {};
	for (const [providerKey, modelKey] of PAIRS) {
		const provider = pins[providerKey];
		if (provider !== '' && !usableProviderIds.has(provider)) {
			patch[providerKey] = '';
			patch[modelKey] = '';
		}
	}
	return patch;
}
