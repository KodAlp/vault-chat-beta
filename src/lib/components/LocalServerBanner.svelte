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
	<div class="banner-slot" transition:motionFly={{ y: -16 }}>
		<div class="vc-banner warning" role="status">
			<span class="dot" aria-hidden="true"></span>
			<TriangleAlertIcon size={20} strokeWidth={1.75} class="banner-icon" aria-hidden="true" />
			<div class="banner-text">
				<div class="t">{t('LocalServerBanner.setupNotFinished')}</div>
				<div class="d">
					<a href="/setup/local-server">{t('LocalServerBanner.openWizard')}</a>
					·
					<a href="/settings/providers">{t('LocalServerBanner.openProviders')}</a>
				</div>
			</div>
		</div>
	</div>
{:else if targetProvider && (status === 'unreachable' || status === 'auth_error')}
	<div class="banner-slot" transition:motionFly={{ y: -16 }}>
		<div class="vc-banner danger" role="alert">
			<span class="dot" aria-hidden="true"></span>
			<TriangleAlertIcon size={20} strokeWidth={1.75} class="banner-icon" aria-hidden="true" />
			<div class="banner-text">
				<div class="t">
					{status === 'auth_error'
						? t('LocalServerBanner.authError', { label: targetLabel })
						: t('LocalServerBanner.unreachable', { label: targetLabel })}
				</div>
				{#if status === 'unreachable' && targetKind === 'ollama'}
					<div class="d">
						{t('LocalServerBanner.installHint')}
						<a href="https://ollama.com" target="_blank" rel="noopener">ollama.com</a>
						· <code>ollama serve</code>
					</div>
				{/if}
			</div>
			<div class="banner-actions">
				{#if status === 'unreachable' && launcherId}
					<button type="button" class="vc-btn secondary" onclick={startServer} disabled={starting || probing}>
						{starting ? t('LocalServerBanner.starting') : t('LocalServerBanner.startNow')}
					</button>
				{/if}
				<button type="button" class="vc-btn secondary" onclick={check} disabled={probing}>
					<RefreshCwIcon size={16} strokeWidth={1.75} aria-hidden="true" class={probing ? 'animate-spin' : ''} />
					{probing ? t('LocalServerBanner.checking') : t('LocalServerBanner.retry')}
				</button>
			</div>
		</div>
	</div>
{:else if targetProvider && status === 'ok' && missingModels.length > 0}
	<div class="banner-slot" transition:motionFly={{ y: -16 }}>
		<div class="vc-banner warning" role="status">
			<span class="dot" aria-hidden="true"></span>
			<TriangleAlertIcon size={20} strokeWidth={1.75} class="banner-icon" aria-hidden="true" />
			<div class="banner-text">
				<div class="t">{t('LocalServerBanner.missingModels', { models: missingModels.join(', ') })}</div>
				<div class="d">
					<a href="/settings/models">{t('LocalServerBanner.pullFromSettings')}</a>
					{t('LocalServerBanner.orRunPull')}
					{#each missingModels as model, i (model)}
						<code>ollama pull {model}</code>{i < missingModels.length - 1 ? ',' : ''}
					{/each}
				</div>
			</div>
		</div>
	</div>
{/if}

<style>
	/* Sticky, not fixed: fixed used to sit outside document flow entirely
	   and permanently cover the chat route's icon rail / panel toggles,
	   which size themselves to fill the space below this banner rather
	   than the raw viewport (see +layout.svelte's .app-shell). Sticky
	   keeps the same "stays visible while the page scrolls" behavior
	   without ever overlapping anything. */
	.banner-slot {
		position: sticky;
		top: 0;
		z-index: 300;
		padding: var(--space-2) var(--space-3) 0;
	}

	.vc-banner {
		align-items: center;
		background: var(--bg-elevated);
	}

	.vc-banner .dot {
		margin-top: 0;
	}

	.vc-banner :global(.banner-icon) {
		flex: none;
	}

	.vc-banner.warning :global(.banner-icon) {
		color: var(--warning);
	}

	.vc-banner.danger :global(.banner-icon) {
		color: var(--danger);
	}

	.banner-text {
		flex: 1;
		min-width: 0;
	}

	.banner-actions {
		display: flex;
		flex: none;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	.vc-banner a {
		color: var(--accent-text);
		text-decoration: underline;
	}

	.vc-banner code {
		background: var(--fill-control);
		border-radius: var(--radius-sm);
		padding: 0.05rem 0.35rem;
		font: var(--text-code);
	}

	.vc-btn:focus-visible,
	.vc-banner a:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}
</style>
