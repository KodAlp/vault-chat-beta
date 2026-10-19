<script lang="ts">
	import { onMount } from 'svelte';
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { Switch } from '$lib/components/ui/switch';
	import { t } from '$lib/i18n/index.svelte';
	import { localizeError } from '$lib/server-error';

	/**
	 * Chat reranker card (Ayarlar > Gömme). GET /api/settings/reranker also reports whether this
	 * machine can run it: the cross-encoder is GPU-only (CUDA) and needs a ~2.3 GB model, so the
	 * switch stays off until both are there. The first status call imports torch server-side and
	 * can take a few seconds, hence the "checking" line.
	 */
	interface Status {
		enabled: boolean;
		pythonOk: boolean;
		cuda: boolean;
		modelPresent: boolean;
		running: boolean;
		downloading: boolean;
	}

	let status = $state<Status | null>(null);
	let loadError = $state('');
	let error = $state('');
	let busy = $state(false);
	let downloading = $state(false);

	async function errorText(res: Response): Promise<string> {
		try {
			const body = (await res.json()) as { code?: string; params?: Record<string, string | number>; message?: string };
			return localizeError({ code: body.code, params: body.params, message: body.message });
		} catch {
			return t('Common.istekBasarisiz', { status: String(res.status) });
		}
	}

	async function load() {
		try {
			const res = await fetch('/api/settings/reranker');
			if (!res.ok) throw new Error();
			status = (await res.json()) as Status;
			downloading = status.downloading;
		} catch {
			loadError = t('RerankerSettingsCard.loadError');
		}
	}

	onMount(() => void load());

	async function post(body: Record<string, unknown>): Promise<Status | null> {
		const res = await fetch('/api/settings/reranker', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		if (!res.ok) {
			error = await errorText(res);
			return null;
		}
		return (await res.json()) as Status;
	}

	async function toggle(next: boolean) {
		busy = true;
		error = '';
		try {
			const result = await post({ enabled: next });
			if (result) status = result;
			else if (status) status = { ...status }; // snap the switch back to the saved value
		} catch {
			error = t('RerankerSettingsCard.saveFailed');
		} finally {
			busy = false;
		}
	}

	async function download() {
		downloading = true;
		error = '';
		try {
			const result = await post({ action: 'download' });
			if (result) status = result;
		} catch {
			error = t('RerankerSettingsCard.downloadFailed');
		} finally {
			downloading = false;
		}
	}

	let canEnable = $derived(!!status && status.cuda && status.modelPresent);
</script>

<Card.Root class="mb-8">
	<Card.Header>
		<Card.Title level={2}>{t('RerankerSettingsCard.title')}</Card.Title>
		<Card.Description>{t('RerankerSettingsCard.description')}</Card.Description>
	</Card.Header>
	<Card.Content class="flex flex-col gap-3">
		{#if loadError}
			<p class="text-sm text-destructive" role="alert">{loadError}</p>
		{:else if !status}
			<p class="text-sm text-muted-foreground">{t('RerankerSettingsCard.checking')}</p>
		{:else}
			<label class="vc-list-row cursor-pointer items-start py-1">
				<span class="flex min-w-0 flex-1 flex-col gap-0.5 text-sm">
					{t('RerankerSettingsCard.enabledLabel')}
					{#if !status.modelPresent && status.cuda}
						<span class="text-xs text-muted-foreground">{t('RerankerSettingsCard.needModel')}</span>
					{/if}
				</span>
				<Switch checked={status.enabled} disabled={busy || (!status.enabled && !canEnable)} onCheckedChange={toggle} />
			</label>

			<ul class="flex flex-col gap-1 text-xs text-muted-foreground" aria-live="polite">
				{#if !status.pythonOk}
					<li>{t('RerankerSettingsCard.pythonMissing')}</li>
				{:else}
					<li>{status.cuda ? t('RerankerSettingsCard.cudaOk') : t('RerankerSettingsCard.cudaMissing')}</li>
				{/if}
				<li>{status.modelPresent ? t('RerankerSettingsCard.modelPresent') : t('RerankerSettingsCard.modelMissing')}</li>
			</ul>

			{#if !status.modelPresent && status.pythonOk}
				<div class="flex items-center gap-2">
					<Button variant="outline" size="sm" disabled={downloading} onclick={download}>
						{downloading ? t('RerankerSettingsCard.downloading') : t('RerankerSettingsCard.downloadButton')}
					</Button>
				</div>
			{/if}
		{/if}
		{#if error}
			<p class="text-sm text-destructive" role="alert">{error}</p>
		{/if}
	</Card.Content>
</Card.Root>
