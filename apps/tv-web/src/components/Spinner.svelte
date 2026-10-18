<script lang="ts">
  let { size = 28, color = 'var(--label-2)' }: { size?: number; color?: string } = $props();
</script>

<span class="spinner" style="width:{size}rem;height:{size}rem;border-color:{color};border-top-color:transparent" role="progressbar"></span>

<style>
  .spinner {
    display: inline-block;
    flex-shrink: 0;
    border: 3rem solid;
    border-radius: 50%;
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
