<script lang="ts">
  import icon from '../../../../brand/wicaby-app-icon.svg';

  let { size = 76 }: { size?: number } = $props();
</script>

<img src={icon} alt="" style="width:{size}rem;height:{size}rem" />
