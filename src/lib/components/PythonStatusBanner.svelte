<script lang="ts">
	import { motionFly } from '$lib/motion';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import { t } from '$lib/i18n/index.svelte';
	import { localizeError, readResponseError } from '$lib/server-error';
	import type { PythonSetupEvent, PythonSystemStatus } from '$lib/types';

	/**
	 * Only PDF/document/YouTube import depends on Python + its required
	 * modules — chat and every other feature works without it — so unlike
	 * LocalServerBanner this always renders in the softer amber "warning"
	 * style, never the red "alert" one, and never polls on an interval:
	 * whether Python/its modules are installed doesn't change while the app
	 * is sitting open the way "Ollama hasn't started yet" does, so a timer
	 * would just be wasted requests. Rechecked on mount, on
	 * visibilitychange (installed it in another window, switched back), and
	 * right after the install-now action finishes.
	 *
	 * Aşama 2b: this used to check `markitdownInstalled` alone; it now
	 * triggers on ANY module in GET /api/system/python's `modules` array
	 * being missing (markitdown, yt_dlp, trafilatura, py_asciimath, pypdf —
	 * see ingest/requirements.txt), since a missing yt_dlp/trafilatura/etc
	 * breaks YouTube/web-link import just as surely as a missing markitdown
	 * breaks document import. `pandoc` is deliberately excluded — it's
	 * optional tooling (see PythonSystemStatus's doc comment) and must never
	 * trigger this banner.
	 */
	type Status = 'checking' | 'ok' | 'missing' | 'no_python';

	let status = $state<Status>('checking');
	let installing = $state(false);
	let logLines = $state<string[]>([]);
	let installFailed = $state(false);
	/** Import names GET /api/system/python reported as not installed —
	 * used only for the `missing` state's log-free summary text below;
	 * empty in every other status. */
	let missingModuleNames = $state<string[]>([]);

	/** Server platform + typed "too old" reason from GET /api/system/python. */
	let platform = $state('win32');
	let problemText = $state<string | null>(null);

	let requestGeneration = 0;

	async function check() {
		const generation = ++requestGeneration;
		try {
			const res = await fetch('/api/system/python');
			if (generation !== requestGeneration) return;
			if (!res.ok) return;
			const data = (await res.json()) as PythonSystemStatus;
			platform = data.platform ?? 'win32';
			problemText = data.pythonProblem ? localizeError(data.pythonProblem) : null;
			missingModuleNames = data.modules.filter((m) => !m.installed).map((m) => m.name);
			if (!data.pythonInstalled) status = 'no_python';
			else if (missingModuleNames.length > 0) status = 'missing';
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
			if (!res.ok) throw new Error(await readResponseError(res));
			if (!res.body) throw new Error(t('Common.istekBasarisiz', { status: res.status }));

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
						logLines = [...logLines, localizeError(event)];
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
	<div class="banner-slot" transition:motionFly={{ y: -16 }}>
		<div class="vc-banner warning" role="status">
			<span class="dot" aria-hidden="true"></span>
			<TriangleAlertIcon size={20} strokeWidth={1.75} class="banner-icon" aria-hidden="true" />
			<div class="banner-text">
				<div class="t">
					{#if status === 'no_python'}
						{#if problemText}{problemText}{' '}{/if}
						{platform === 'darwin'
							? t('PythonStatusBanner.noPythonMac')
							: platform === 'linux'
								? t('PythonStatusBanner.noPythonLinux')
								: t('PythonStatusBanner.noPython')}
						{#if platform !== 'linux'}
							<a href="https://python.org" target="_blank" rel="noopener">python.org</a>
						{/if}
					{:else}
						{t('PythonStatusBanner.missingModules', { modules: missingModuleNames.join(', ') })}
					{/if}
				</div>
				{#if logLines.length > 0}
					<pre class="python-banner-log" class:python-banner-log--error={installFailed}>{logLines.join('\n')}</pre>
				{/if}
			</div>
			{#if status === 'missing'}
				<div class="banner-actions">
					<button type="button" class="vc-btn secondary" onclick={install} disabled={installing}>
						<RefreshCwIcon size={16} strokeWidth={1.75} aria-hidden="true" class={installing ? 'animate-spin' : ''} />
						{installing ? t('PythonStatusBanner.installing') : t('PythonStatusBanner.installNow')}
					</button>
				</div>
			{/if}
		</div>
	</div>
{/if}

<style>
	.banner-slot {
		position: sticky;
		top: 0;
		z-index: 290;
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
		color: var(--warning);
	}

	.banner-text {
		flex: 1;
		min-width: 0;
	}

	.banner-actions {
		display: flex;
		flex: none;
		gap: var(--space-2);
	}

	.vc-banner a {
		color: var(--accent-text);
		text-decoration: underline;
	}

	.vc-btn:focus-visible,
	.vc-banner a:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}

	.python-banner-log {
		max-height: 8rem;
		overflow-y: auto;
		margin: var(--space-2) 0 0;
		font: var(--text-code);
		font-size: 12px;
		background: var(--fill-control);
		border-radius: var(--radius-sm);
		padding: 0.4rem 0.6rem;
		white-space: pre-wrap;
	}

	.python-banner-log--error {
		color: var(--danger);
	}
</style>
