/**
 * A page-agnostic signal for "the user wants their current source-tree
 * scope selection cleared" — fired from the global generation-error toast
 * (routes/+layout.svelte, which has no access to any one chat page's local
 * includedPaths state) and observed by the chat page that actually owns
 * that state (routes/vault/[id]/chat/[chatId]/+page.svelte). Same
 * nonce-counter pattern as SourceTree's focusSignal prop — incrementing is
 * the event, the value itself carries no meaning. A plain prop can't do
 * this because the toast and the page that would need to react to it are
 * siblings in the component tree, not parent/child.
 */
export const scopeExpandSignal = $state({ value: 0 });

export function requestScopeExpand(): void {
	scopeExpandSignal.value += 1;
}
