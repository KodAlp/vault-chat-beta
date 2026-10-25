<script lang="ts">
	import { cn, type WithElementRef } from "#lib/utils.js";
	import type { HTMLAttributes } from "svelte/elements";

	let {
		ref = $bindable(null),
		class: className,
		children,
		size = "default",
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> & { size?: "default" | "sm" } = $props();
</script>

<div
	bind:this={ref}
	data-slot="card"
	data-size={size}
	class={cn("gap-(--card-spacing) overflow-hidden rounded-[var(--radius-lg)] bg-card py-(--card-spacing) text-sm text-card-foreground shadow-[inset_0_0_0_1px_var(--separator)] [--card-spacing:--spacing(4)] has-data-[slot=card-footer]:pb-0 has-[>img:first-child]:pt-0 data-[size=sm]:[--card-spacing:--spacing(3)] data-[size=sm]:has-data-[slot=card-footer]:pb-0 *:[img:first-child]:rounded-t-[var(--radius-lg)] *:[img:last-child]:rounded-b-[var(--radius-lg)] group/card flex flex-col", className)}
	{...restProps}
>
	{@render children?.()}
</div>
