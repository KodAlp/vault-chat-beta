<script lang="ts">
	import { fly } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import { t } from '$lib/i18n/index.svelte';
	import type { PythonSetupEvent } from '$lib/types';

	/**
	 * Only PDF/document/YouTube import depends on Python + markitdown — chat
	 * and every other feature works without it — so unlike OllamaStatusBanner
	 * this always renders in the softer amber "warning" style, never the red
	 * "alert" one, and never polls on an interval: whether Python/markitdown
	 * are installed doesn't change while the app is sitting open the way
	 * "Ollama hasn't started yet" does, so a timer would just be wasted
	 * requests. Rechecked on mount, on visibilitychange (installed it in
	 * another window, switched back), and right after the install-now
	 * action finishes.
	 */
	type Status = 'checking' | 'ok' | 'missing' | 'no_python';

	let status = $state<Status>('checking');
	let installing = $state(false);
	let logLines = $state<string[]>([]);
	let installFailed = $state(false);

	let requestGeneration = 0;

	async function check() {
		const generation = ++requestGeneration;
		try {
			const res = await fetch('/api/system/python');
			if (generation !== requestGeneration) return;
			if (!res.ok) return;
			const data = (await res.json()) as { pythonInstalled: boolean; markitdownInstalled: boolean };
			if (!data.pythonInstalled) status = 'no_python';
			else if (!data.markitdownInstalled) status = 'missing';
			else status = 'ok';
		} catch {
			// Best-effort — never blocks the app, only powers this banner.
		}
	}

	async function install() {
		installing = true;
		installFailed = false;
		logLines = [];
		try {
			const res = await fetch('/api/system/python', { method: 'POST' });
			if (!res.ok || !res.body) throw new Error('İstek başarısız');

			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			let ok = false;
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const parts = buffer.split('\n\n');
				buffer = parts.pop() ?? '';
				for (const part of parts) {
					const line = part.trim();
					if (!line.startsWith('data:')) continue;
					const event = JSON.parse(line.slice(5)) as PythonSetupEvent;
					if (event.type === 'log') logLines = [...logLines, event.line];
					else if (event.type === 'error') {
						logLines = [...logLines, event.message];
						installFailed = true;
					} else if (event.type === 'done') ok = event.ok;
				}
			}
			installFailed = installFailed || !ok;
		} catch {
			installFailed = true;
		} finally {
			installing = false;
			await check();
		}
	}

	$effect(() => {
		check();

		function onVisibilityChange() {
			if (document.visibilityState === 'visible') check();
		}
		document.addEventListener('visibilitychange', onVisibilityChange);
		return () => document.removeEventListener('visibilitychange', onVisibilityChange);
	});
</script>

{#if status === 'missing' || status === 'no_python'}
	<div class="python-banner" role="status" transition:fly={{ y: -16, duration: 220, easing: cubicOut }}>
		<TriangleAlertIcon size={16} aria-hidden="true" />
		<span>
			{status === 'no_python'
				? t('PythonStatusBanner.noPython')
				: t('PythonStatusBanner.missingMarkitdown')}
			{#if status === 'no_python'}
				<a href="https://python.org" target="_blank" rel="noopener">python.org</a>
			{/if}
		</span>
		{#if status === 'missing'}
			<button type="button" onclick={install} disabled={installing}>
				<RefreshCwIcon size={13} aria-hidden="true" class={installing ? 'animate-spin' : ''} />
				{installing ? t('PythonStatusBanner.installing') : t('PythonStatusBanner.installNow')}
			</button>
		{/if}
		{#if logLines.length > 0}
			<pre class="python-banner-log" class:python-banner-log--error={installFailed}>{logLines.join('\n')}</pre>
		{/if}
	</div>
{/if}

<style>
	.python-banner {
		position: sticky;
		top: 0;
		z-index: 290;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-wrap: wrap;
		gap: 0.6rem;
		padding: 0.6rem 1rem;
		background: var(--ground);
		border-bottom: 1px solid #d97706;
		color: #d97706;
		font-size: 0.85rem;
		text-align: center;
	}

	.python-banner button {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		background: transparent;
		border: 1px solid #d97706;
		color: #d97706;
		border-radius: var(--radius-pill);
		padding: 0.25rem 0.7rem;
		font-size: 0.8rem;
		cursor: pointer;
	}

	.python-banner button:hover:not(:disabled) {
		background: color-mix(in srgb, #d97706 12%, transparent);
	}

	.python-banner button:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.python-banner button:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	.python-banner a {
		color: inherit;
		text-decoration: underline;
	}

	.python-banner-log {
		flex-basis: 100%;
		max-height: 8rem;
		overflow-y: auto;
		margin: 0;
		text-align: left;
		font-size: 0.75rem;
		background: color-mix(in srgb, #d97706 8%, transparent);
		border-radius: var(--radius-sm, 4px);
		padding: 0.4rem 0.6rem;
		white-space: pre-wrap;
	}

	.python-banner-log--error {
		color: var(--color-destructive);
	}
</style>
