<script lang="ts">
	import { onMount } from 'svelte';
	import type { Snippet } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Select from '$lib/components/ui/select';

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
		icon,
		label,
		dialogTitle,
		promptLabel,
		promptPlaceholder,
		disabled = false,
		canGenerate = true,
		badge = null,
		open = $bindable(false),
		onGenerate,
		extraTop,
		extraFields
	}: {
		chatId: string;
		icon: string;
		label: string;
		dialogTitle: string;
		promptLabel: string;
		promptPlaceholder: string;
		disabled?: boolean;
		canGenerate?: boolean;
		badge?: number | null;
		open?: boolean;
		onGenerate: (args: { prompt: string; domains?: string[]; chatId?: string }) => void;
		extraTop?: Snippet;
		extraFields?: Snippet;
	} = $props();

	let domains = $state<string[]>([]);
	let selectedDomain = $state('');
	let useChatContext = $state(true);
	let prompt = $state('');

	onMount(async () => {
		try {
			const res = await fetch('/api/domains');
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
			prompt: prompt.trim()
		});
	}
</script>

<button
	type="button"
	class="flex flex-col items-center gap-0.5 border-none bg-transparent p-0 text-muted-foreground hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
	onclick={openDialog}
	{disabled}
	title={dialogTitle}
>
	<span class="relative inline-flex">
		{icon}
		{#if badge}
			<span
				class="absolute -top-1.5 -right-2.5 rounded-full bg-primary px-1 text-[0.6rem] leading-none font-bold text-primary-foreground"
			>
				{badge > 99 ? '99+' : badge}
			</span>
		{/if}
	</span>
	<span class="text-[0.65rem]">{label}</span>
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
			Domain (opsiyonel)
			<Select.Root type="single" bind:value={selectedDomain}>
				<Select.Trigger class="w-full">
					{selectedDomain || 'Tüm domainler'}
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
			Bu konuşmayı bağlam olarak kullan
		</label>

		<label class="flex flex-col gap-1 text-sm">
			{promptLabel}
			<Textarea bind:value={prompt} placeholder={promptPlaceholder} class="min-h-16" />
		</label>

		{#if extraFields}
			{@render extraFields()}
		{/if}

		<Dialog.Footer>
			<Button variant="outline" onclick={() => (open = false)}>İptal</Button>
			<Button onclick={generate} disabled={!prompt.trim() || !canGenerate}>Oluştur</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
