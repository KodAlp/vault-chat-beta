<script lang="ts">
	import { cn, type WithElementRef } from "$lib/utils.js";
	import type { HTMLAttributes } from "svelte/elements";

	let {
		ref = $bindable(null),
		class: className,
		children,
		level,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> & { level?: 2 | 3 | 4 } = $props();
</script>

{#if level}
	<svelte:element
		this={'h' + level}
		bind:this={ref}
		data-slot="card-title"
		class={cn("text-base leading-snug font-medium group-data-[size=sm]/card:text-sm", className)}
		{...restProps}
	>
		{@render children?.()}
	</svelte:element>
{:else}
	<div
		bind:this={ref}
		data-slot="card-title"
		class={cn("text-base leading-snug font-medium group-data-[size=sm]/card:text-sm", className)}
		{...restProps}
	>
		{@render children?.()}
	</div>
{/if}
