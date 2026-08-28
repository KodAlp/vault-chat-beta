<script lang="ts">
	import { onMount } from 'svelte';
	import type { Snippet } from 'svelte';
	import type { LucideIcon } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Select from '$lib/components/ui/select';
	import { t } from '$lib/i18n/index.svelte';

	/**
	 * Shared shell for the five generation dialogs (quiz/cards/report/
	 * mindmap/slides) — Faz 9 Adım 4. Before this, each was a near-identical
	 * ~215-260 line file differing only in labels, an optional extra field
	 * (quiz's mc/tf/open composition, cards' count+due-badge+review CTA),
	 * and which *-generation.svelte.ts store it called. Those five store
	 * modules stay separate on purpose (see frontend-revamp skill) — they're
	 * state logic, not UI, and unifying them wasn't part of this pass. This
	 * component owns only the generic UI: trigger button, domain/context/
	 * prompt fields, and the open/close/generate dialog chrome. Type-specific
	 * extra fields and the final store call stay with the caller via
	 * onGenerate + the extraTop/extraFields snippets, which close over
	 * whatever local state (mc, tf, count...) that caller needs.
	 */
	let {
		chatId,
		vaultId,
		icon,
		label,
		dialogTitle,
		promptLabel,
		promptPlaceholder,
		disabled = false,
		canGenerate = true,
		badge = null,
		open = $bindable(false),
		includedPaths,
		onGenerate,
		extraTop,
		extraFields
	}: {
		chatId: string;
		vaultId: string;
		icon: LucideIcon;
		label: string;
		dialogTitle: string;
		promptLabel: string;
		promptPlaceholder: string;
		disabled?: boolean;
		canGenerate?: boolean;
		badge?: number | null;
		open?: boolean;
		/** Chat's own source-tree scope selection (Faz 12) — forwarded as-is
		 * into onGenerate's args so generation uses the same scope the chat
		 * itself is currently answering from. */
		includedPaths?: string[];
		onGenerate: (args: {
			prompt: string;
			domains?: string[];
			chatId?: string;
			vault: string;
			includedPaths?: string[];
		}) => void;
		extraTop?: Snippet;
		extraFields?: Snippet;
	} = $props();

	// Capitalized local binding — Svelte only treats a tag as a dynamic
	// component when its name starts uppercase, so the lowercase `icon`
	// prop can't be used as `<icon />` directly.
	let Icon = $derived(icon);

	let domains = $state<string[]>([]);
	let selectedDomain = $state('');
	let useChatContext = $state(true);
	let prompt = $state('');

	onMount(async () => {
		try {
			const res = await fetch(`/api/domains?vault=${encodeURIComponent(vaultId)}`);
			if (res.ok) domains = (await res.json()) as string[];
		} catch {
			// domain list stays empty — dropdown just shows "Tüm domainler"
		}
	});

	function openDialog() {
		if (disabled) return;
		open = true;
	}

	function generate() {
		if (!prompt.trim() || !canGenerate || disabled) return;
		open = false;
		onGenerate({
			domains: selectedDomain ? [selectedDomain] : undefined,
			chatId: useChatContext ? chatId : undefined,
			prompt: prompt.trim(),
			vault: vaultId,
			includedPaths
		});
	}
</script>

<button
	type="button"
	class="flex flex-col items-center gap-0.5 rounded-sm border-none bg-transparent p-0 text-muted-foreground hover:text-primary disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-2"
	onclick={openDialog}
	{disabled}
	title={dialogTitle}
>
	<span class="relative inline-flex">
		<Icon size={19} aria-hidden="true" />
		{#if badge}
			<span
				class="absolute -top-1.5 -right-2.5 rounded-full bg-primary px-1 text-[0.6875rem] leading-none font-bold text-primary-foreground"
			>
				{badge > 99 ? '99+' : badge}
			</span>
		{/if}
	</span>
	<span class="text-[0.6875rem]">{label}</span>
</button>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>{dialogTitle}</Dialog.Title>
		</Dialog.Header>

		{#if extraTop}
			{@render extraTop()}
		{/if}

		<label class="flex flex-col gap-1 text-sm">
			{t('GenerationDialog.domainLabel')}
			<Select.Root type="single" bind:value={selectedDomain}>
				<Select.Trigger class="w-full">
					{selectedDomain || t('GenerationDialog.allDomains')}
				</Select.Trigger>
				<Select.Content>
					{#each domains as d (d)}
						<Select.Item value={d} label={d}>{d}</Select.Item>
					{/each}
				</Select.Content>
			</Select.Root>
		</label>

		<label class="flex cursor-pointer items-center gap-2 text-sm">
			<Checkbox bind:checked={useChatContext} />
			{t('GenerationDialog.useChatContext')}
		</label>

		<label class="flex flex-col gap-1 text-sm">
			{promptLabel}
			<Textarea bind:value={prompt} placeholder={promptPlaceholder} class="min-h-16" />
		</label>

		{#if extraFields}
			{@render extraFields()}
		{/if}

		<Dialog.Footer>
			<Button variant="outline" onclick={() => (open = false)}>{t('Common.iptal')}</Button>
			<Button onclick={generate} disabled={!prompt.trim() || !canGenerate}>{t('GenerationDialog.generate')}</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
