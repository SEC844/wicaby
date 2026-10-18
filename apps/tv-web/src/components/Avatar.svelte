<script lang="ts">
  // "Who's watching?" avatar (ui/Setup.kt Avatar): the user's picture, else their initial, or "+" for another user.
  import { focusable } from '../lib/focus';

  let {
    label,
    image,
    plus = false,
    autofocus = false,
    onclick,
  }: { label: string; image?: string; plus?: boolean; autofocus?: boolean; onclick: () => void } = $props();
</script>

<button class="avatar" use:focusable={autofocus} {onclick}>
  <span class="disc">
    {#if image}<img src={image} alt="" />{:else}<span class="t-large-title">{plus ? '+' : label.slice(0, 1).toUpperCase()}</span>{/if}
  </span>
  <span class="name t-callout ellipsis">{label}</span>
</button>

<style>
  .avatar {
    display: flex;
    flex-direction: column;
    align-items: center;
    width: 120rem;
    margin: 0 14rem;
  }
  .disc {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 104rem;
    height: 104rem;
    border-radius: 50%;
    overflow: hidden;
    background: var(--elevated-2);
    transition: transform var(--t-fast) var(--ease-out), background-color var(--t-fast);
  }
  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .name {
    max-width: 100%;
    margin-top: 16rem;
    color: var(--label-2);
  }
  .avatar:global(.focused) .disc {
    background: var(--raised);
    transform: scale(1.12);
  }
  .avatar:global(.focused) .name {
    color: var(--label);
  }
</style>
