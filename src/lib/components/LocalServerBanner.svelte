<script lang="ts">
	import { untrack } from 'svelte';
	import { motionFly } from '$lib/motion';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import { isTauri, invoke } from '@tauri-apps/api/core';
	import { afterNavigate } from '$app/navigation';
	import { t } from '$lib/i18n/index.svelte';
	import { settings } from '$lib/settings.svelte';
	import { resolveBannerTarget, findLauncherId, type BannerTarget } from '$lib/localServerBanner';
	import type { LauncherConfig, ProviderStatus } from '$lib/types';

	/**
	 * App-wide, not per-page, and provider-agnostic (Aşama 4d; it used to be hardcoded to the 'ollama' provider).
	 * It looks at the provider chat will actually use — the client pin when it names an enabled provider, else
	 * the head of the chat chain (resolveBannerTarget, localServerBanner.ts) — and shows:
	 *  - "setup not finished" (link to the wizard / Settings > Providers) when nothing resolves — no polling;
	 *  - "local server <label> isn't running" (with Start when a launcher exists for it) when that provider is a
	 *    local one (kind ollama or marked local) and its test endpoint says it is down — polled every 15 s
	 *    while unhealthy;
	 *  - nothing for a cloud provider.
	 * The "required model not pulled" warning stays Ollama-only (that entry's defaultModel / embedding model).
	 */
	type Status = 'checking' | 'ok' | 'unreachable' | 'auth_error';

	let target = $state<BannerTarget>({ state: 'none' });
	let providers = $state<ProviderStatus[]>([]);
	let status = $state<Status>('checking');
	let probing = $state(false);
	/** Id of the launcher (Tauri) that can start the target's server — null when none is configured. Checked
	 * when the target changes, not on every poll: whether a launcher exists doesn't change while the banner
	 * is showing. */
	let launcherId = $state<string | null>(null);
	let starting = $state(false);
	let missingModels = $state<string[]>([]);

	let targetProvider = $derived(target.state === 'local' ? target.provider : null);
	let targetId = $derived(targetProvider?.id ?? null);
	let targetLabel = $derived(targetProvider?.label ?? '');
	let targetKind = $derived(targetProvider?.kind ?? null);

	// mount, visibilitychange, navigation, the 15 s poll and the retry button all call check() independently
	// with no cancellation between them — an older, slower probe can otherwise resolve AFTER a newer
	// successful one and stomp status back to 'unreachable'. Guard by generation: only the result of the most
	// recently issued check() may write state.
	let requestGeneration = 0;

	async function loadTarget() {
		try {
			const [providersRes, chainsRes] = await Promise.all([fetch('/api/providers'), fetch('/api/providers/chains')]);
			if (!providersRes.ok || !chainsRes.ok) return;
			providers = (await providersRes.json()) as ProviderStatus[];
			const chains = (await chainsRes.json()) as Record<string, string[]>;
			target = resolveBannerTarget({
				pins: [settings.fastProvider, settings.reasoningProvider, settings.defaultProvider],
				providers,
				chatChain: chains.chat ?? []
			});
		} catch {
			// Best-effort — a failed load just leaves the previous state; this banner never blocks the app.
		}
	}

	async function loadLauncher() {
		launcherId = null;
		if (!isTauri() || !targetProvider) return;
		try {
			const list = await invoke<LauncherConfig[]>('list_launchers');
			launcherId = findLauncherId(targetProvider, list);
		} catch {
			launcherId = null;
		}
	}

	async function startServer() {
		if (!launcherId) return;
		starting = true;
		try {
			await invoke('start_launcher', { id: launcherId });
		} catch {
			// start_launcher's own error isn't surfaced here — the recheck below already reflects reality
			// (still unreachable if it really failed), which is what this banner cares about.
		} finally {
			starting = false;
			await check();
		}
	}

	/** Base+tag match, same rule as scripts/doctor.mjs's modelInstalled(). */
	function modelInstalled(installed: string[], wanted: string): boolean {
		const [wantedBase, wantedTag] = wanted.split(':');
		return installed.some((name) => {
			const [base, tag] = name.split(':');
			if (base !== wantedBase) return false;
			return wantedTag === undefined || tag === wantedTag;
		});
	}

	/** Ollama only: the required models come from the server (that entry's defaultModel, plus the embedding
	 * model when this Ollama provider is the one configured for embedding) — never hardcoded here. */
	async function checkModels(ollama: ProviderStatus) {
		try {
			const modelsRes = await fetch('/api/models');
			if (!modelsRes.ok) return;
			const installed = ((await modelsRes.json()) as { name: string }[]).map((m) => m.name);
			const required = [ollama.defaultModel, ollama.embedModel].filter((m): m is string => !!m);
			missingModels = required.filter((m) => !modelInstalled(installed, m));
		} catch {
			// Best-effort — it only powers an optional warning band.
		}
	}

	async function check() {
		const id = targetId;
		if (!id) return;
		const generation = ++requestGeneration;
		probing = true;
		try {
			const res = await fetch(`/api/providers/${encodeURIComponent(id)}/test`, { method: 'POST' });
			if (generation !== requestGeneration) return;
			if (!res.ok) {
				status = 'unreachable';
				return;
			}
			const data = (await res.json()) as { status: Status };
			status = data.status;
			const entry = providers.find((p) => p.id === id);
			if (status === 'ok' && entry?.kind === 'ollama') void checkModels(entry);
			else missingModels = [];
		} catch {
			if (generation === requestGeneration) status = 'unreachable';
		} finally {
			if (generation === requestGeneration) probing = false;
		}
	}

	$effect(() => {
		void loadTarget();
		// The exact scenario this exists for: the user starts the server *after* opening the app, then
		// switches back to it — recheck right then instead of making them wait for the poll interval.
		function onVisibilityChange() {
			if (document.visibilityState === 'visible') void loadTarget().then(check);
		}
		document.addEventListener('visibilitychange', onVisibilityChange);
		return () => document.removeEventListener('visibilitychange', onVisibilityChange);
	});

	// Coming back from Settings > Providers / the wizard: the chain or the pin may have changed.
	afterNavigate(() => {
		void loadTarget();
	});

	// A different target provider (or none): reset and probe it.
	$effect(() => {
		const id = targetId;
		status = 'checking';
		missingModels = [];
		if (!id) return;
		// untrack: loadLauncher()/check() read other state synchronously; only a CHANGE of target id may
		// re-run this effect, not every refresh of the providers list.
		untrack(() => {
			void loadLauncher();
			void check();
		});
	});

	// Only polls while the local server is unhealthy, and stops the moment it recovers — nothing runs at all
	// in the common case (server up), for a cloud provider, or in the "setup not finished" state.
	$effect(() => {
		if (!targetId || status === 'ok' || status === 'checking') return;
		const timer = setInterval(check, 15000);
		return () => clearInterval(timer);
	});
</script>

{#if target.state === 'setup'}
	<div class="local-banner local-banner--warning" role="status" transition:motionFly={{ y: -16 }}>
		<TriangleAlertIcon size={16} aria-hidden="true" />
		<span>
			{t('LocalServerBanner.setupNotFinished')}
			<a href="/setup/local-server">{t('LocalServerBanner.openWizard')}</a>
			·
			<a href="/settings/providers">{t('LocalServerBanner.openProviders')}</a>
		</span>
	</div>
{:else if targetProvider && (status === 'unreachable' || status === 'auth_error')}
	<div class="local-banner" role="alert" transition:motionFly={{ y: -16 }}>
		<TriangleAlertIcon size={16} aria-hidden="true" />
		<span>
			{status === 'auth_error'
				? t('LocalServerBanner.authError', { label: targetLabel })
				: t('LocalServerBanner.unreachable', { label: targetLabel })}
			{#if status === 'unreachable' && targetKind === 'ollama'}
				{t('LocalServerBanner.installHint')}
				<a href="https://ollama.com" target="_blank" rel="noopener">ollama.com</a>
				· <code>ollama serve</code>
			{/if}
		</span>
		{#if status === 'unreachable' && launcherId}
			<button type="button" onclick={startServer} disabled={starting || probing}>
				{starting ? t('LocalServerBanner.starting') : t('LocalServerBanner.startNow')}
			</button>
		{/if}
		<button type="button" onclick={check} disabled={probing}>
			<RefreshCwIcon size={13} aria-hidden="true" class={probing ? 'animate-spin' : ''} />
			{probing ? t('LocalServerBanner.checking') : t('LocalServerBanner.retry')}
		</button>
	</div>
{:else if targetProvider && status === 'ok' && missingModels.length > 0}
	<div class="local-banner local-banner--warning" role="status" transition:motionFly={{ y: -16 }}>
		<TriangleAlertIcon size={16} aria-hidden="true" />
		<span>
			{t('LocalServerBanner.missingModels', { models: missingModels.join(', ') })}
			<a href="/settings">{t('LocalServerBanner.pullFromSettings')}</a>
			{t('LocalServerBanner.orRunPull')}
			{#each missingModels as model, i (model)}
				<code>ollama pull {model}</code>{i < missingModels.length - 1 ? ',' : ''}
			{/each}
		</span>
	</div>
{/if}

<style>
	.local-banner {
		/* Sticky, not fixed: fixed used to sit outside document flow entirely
		   and permanently cover the chat route's icon rail / panel toggles,
		   which size themselves to fill the space below this banner rather
		   than the raw viewport (see +layout.svelte's .app-shell). Sticky
		   keeps the same "stays visible while the page scrolls" behavior
		   without ever overlapping anything. */
		position: sticky;
		top: 0;
		z-index: 300;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-wrap: wrap;
		gap: 0.6rem;
		padding: 0.6rem 1rem;
		background: var(--ground);
		border-bottom: 1px solid var(--color-destructive);
		color: var(--color-destructive);
		font-size: 0.85rem;
		text-align: center;
	}

	.local-banner button {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		background: transparent;
		border: 1px solid var(--color-destructive);
		color: var(--color-destructive);
		border-radius: var(--radius-pill);
		padding: 0.25rem 0.7rem;
		font-size: 0.8rem;
		cursor: pointer;
	}

	.local-banner button:hover:not(:disabled) {
		background: color-mix(in srgb, var(--color-destructive) 12%, transparent);
	}

	.local-banner button:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.local-banner button:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	/* The server is up (or setup simply isn't finished) — not the same severity as "chat is entirely
	   unavailable", so this gets its own softer color rather than reusing --color-destructive. */
	.local-banner--warning {
		border-bottom-color: var(--warning);
		color: var(--warning);
	}

	.local-banner code {
		background: color-mix(in srgb, currentColor 12%, transparent);
		border-radius: var(--radius-sm, 4px);
		padding: 0.05rem 0.35rem;
	}

	.local-banner a {
		color: inherit;
		text-decoration: underline;
	}
</style>
