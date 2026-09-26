<script lang="ts">
	import { motionFly } from '$lib/motion';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import { t } from '$lib/i18n/index.svelte';
	import type { ProviderStatus } from '$lib/types';

	/**
	 * App-wide, not per-page: Ollama being down blocks every feature (chat,
	 * quiz/card/report/mindmap/slide generation all chain through it per
	 * data/providers.json), so this lives in +layout.svelte, not the chat
	 * route specifically. Scoped to the 'ollama' provider id deliberately —
	 * PRODUCT.md treats it as the always-required base dependency, unlike
	 * optional/off-by-default cloud providers; a provider-agnostic version
	 * is a reasonable future step, not needed for this.
	 */
	type Status = 'checking' | 'ok' | 'unreachable' | 'auth_error';

	let status = $state<Status>('checking');
	let probing = $state(false);
	/** Populated only once Ollama itself answers 'ok' — required model names
	 * come from the server (providers.json's ollama.defaultModel + embed-
	 * config.ts's EMBED_MODEL via /api/providers), never hardcoded here, so
	 * this can't drift the way KURULUM.md once did (nomic-embed-text vs the
	 * real bge-m3). */
	let missingModels = $state<string[]>([]);

	// mount, visibilitychange, the 15s poll, and the manual retry button all
	// call check() independently with no cancellation between them — an
	// older, slower probe (e.g. one that started while Ollama was still
	// down) can otherwise resolve AFTER a newer successful one and stomp
	// status back to 'unreachable'. Guard by generation: only the result of
	// the most recently issued check() is ever allowed to write state.
	let requestGeneration = 0;

	/** Base+tag match, same rule as scripts/doctor.mjs's modelInstalled():
	 * "bge-m3" (no tag) matches an installed "bge-m3:latest"; "qwen3:8b"
	 * only matches that exact tag. */
	function modelInstalled(installed: string[], wanted: string): boolean {
		const [wantedBase, wantedTag] = wanted.split(':');
		return installed.some((name) => {
			const [base, tag] = name.split(':');
			if (base !== wantedBase) return false;
			return wantedTag === undefined || tag === wantedTag;
		});
	}

	async function checkModels() {
		try {
			const [providersRes, modelsRes] = await Promise.all([
				fetch('/api/providers'),
				fetch('/api/models')
			]);
			if (!providersRes.ok || !modelsRes.ok) return;
			const providers = (await providersRes.json()) as ProviderStatus[];
			const installed = (await modelsRes.json()) as { name: string }[];
			const installedNames = installed.map((m) => m.name);
			const ollama = providers.find((p) => p.id === 'ollama');
			const required = [ollama?.defaultModel, ollama?.embedModel].filter(
				(m): m is string => !!m
			);
			missingModels = required.filter((m) => !modelInstalled(installedNames, m));
		} catch {
			// Best-effort — a failed check here must never block the app,
			// it only powers an optional warning banner.
		}
	}

	async function check() {
		const generation = ++requestGeneration;
		probing = true;
		try {
			const res = await fetch('/api/providers/ollama/test', { method: 'POST' });
			if (generation !== requestGeneration) return;
			if (!res.ok) {
				status = 'unreachable';
				return;
			}
			const data = (await res.json()) as { status: Status };
			status = data.status;
			if (status === 'ok') void checkModels();
		} catch {
			if (generation === requestGeneration) status = 'unreachable';
		} finally {
			if (generation === requestGeneration) probing = false;
		}
	}

	$effect(() => {
		check();

		// The exact scenario this exists for: the user starts Ollama *after*
		// opening the app, then switches back to it — recheck right then
		// instead of making them wait for the poll interval or reload.
		function onVisibilityChange() {
			if (document.visibilityState === 'visible') check();
		}
		document.addEventListener('visibilitychange', onVisibilityChange);
		return () => document.removeEventListener('visibilitychange', onVisibilityChange);
	});

	// Only polls while unhealthy, and stops the moment it recovers — this
	// never runs at all in the common case (Ollama already up).
	$effect(() => {
		if (status === 'ok' || status === 'checking') return;
		const id = setInterval(check, 15000);
		return () => clearInterval(id);
	});
</script>

{#if status === 'unreachable' || status === 'auth_error'}
	<div class="ollama-banner" role="alert" transition:motionFly={{ y: -16 }}>
		<TriangleAlertIcon size={16} aria-hidden="true" />
		<span>
			{status === 'auth_error'
				? t('OllamaStatusBanner.authError')
				: t('OllamaStatusBanner.unreachable')}
			{#if status === 'unreachable'}
				{t('OllamaStatusBanner.installHint')}
				<a href="https://ollama.com" target="_blank" rel="noopener">ollama.com</a>
				· <code>ollama serve</code>
			{/if}
		</span>
		<button type="button" onclick={check} disabled={probing}>
			<RefreshCwIcon size={13} aria-hidden="true" class={probing ? 'animate-spin' : ''} />
			{probing ? t('OllamaStatusBanner.checking') : t('OllamaStatusBanner.retry')}
		</button>
	</div>
{:else if status === 'ok' && missingModels.length > 0}
	<div class="ollama-banner ollama-banner--warning" role="status" transition:motionFly={{ y: -16 }}>
		<TriangleAlertIcon size={16} aria-hidden="true" />
		<span>
			{t('OllamaStatusBanner.missingModels', { models: missingModels.join(', ') })}
			<a href="/settings">{t('OllamaStatusBanner.pullFromSettings')}</a>
			{t('OllamaStatusBanner.orRunPull')}
			{#each missingModels as model, i (model)}
				<code>ollama pull {model}</code>{i < missingModels.length - 1 ? ',' : ''}
			{/each}
		</span>
	</div>
{/if}

<style>
	.ollama-banner {
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

	.ollama-banner button {
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

	.ollama-banner button:hover:not(:disabled) {
		background: color-mix(in srgb, var(--color-destructive) 12%, transparent);
	}

	.ollama-banner button:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.ollama-banner button:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	/* Ollama itself is up here — a missing model is not the same severity
	   as "chat is entirely unavailable", so this gets its own softer color
	   rather than reusing --color-destructive. */
	.ollama-banner--warning {
		border-bottom-color: var(--warning);
		color: var(--warning);
	}

	.ollama-banner code {
		background: color-mix(in srgb, currentColor 12%, transparent);
		border-radius: var(--radius-sm, 4px);
		padding: 0.05rem 0.35rem;
	}

	.ollama-banner a {
		color: inherit;
		text-decoration: underline;
	}
</style>
