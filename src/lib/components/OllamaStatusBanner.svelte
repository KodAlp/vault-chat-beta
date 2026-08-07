<script lang="ts">
	import { fly } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';

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

	// mount, visibilitychange, the 15s poll, and the manual retry button all
	// call check() independently with no cancellation between them — an
	// older, slower probe (e.g. one that started while Ollama was still
	// down) can otherwise resolve AFTER a newer successful one and stomp
	// status back to 'unreachable'. Guard by generation: only the result of
	// the most recently issued check() is ever allowed to write state.
	let requestGeneration = 0;

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
	<div class="ollama-banner" role="alert" transition:fly={{ y: -16, duration: 220, easing: cubicOut }}>
		<TriangleAlertIcon size={16} aria-hidden="true" />
		<span>
			{status === 'auth_error'
				? 'Ollama kimlik doğrulama hatası verdi.'
				: 'Ollama çalışmıyor — sohbet ve çalışma materyali üretimi şu anda kullanılamıyor.'}
		</span>
		<button type="button" onclick={check} disabled={probing}>
			<RefreshCwIcon size={13} aria-hidden="true" class={probing ? 'animate-spin' : ''} />
			{probing ? 'Kontrol ediliyor...' : 'Yeniden dene'}
		</button>
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
</style>
