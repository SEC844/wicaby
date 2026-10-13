<script lang="ts">
  import { TICKS_PER_MS } from '../../shared/contract';
  import { clock } from '../lib/format';
  import { t, tParts } from '../lib/i18n.svelte';
  import { answerResume, resumePrompt } from '../lib/resume.svelte';
  import Sheet from './Sheet.svelte';

  // Settings > Lecture > Reprise = "Toujours demander".
</script>

<Sheet open={resumePrompt.open} onclose={() => answerResume(null)} label={t('player.resume.title')} width={400}>
  <div class="body">
    <h2 class="title-3">{resumePrompt.name}</h2>
    <p class="footnote">
      {#each tParts('player.resume.stoppedAt') as part, i (i)}{#if part.slot === 'time'}<span class="mono">{clock(resumePrompt.ticks / TICKS_PER_MS)}</span>{:else}{part.text}{/if}{/each}
    </p>
    <div class="actions">
      <button class="btn primary" data-autofocus onclick={() => answerResume('resume')}>{t('player.resume.resume')}</button>
      <button class="btn" onclick={() => answerResume('start')}>{t('player.resume.fromStart')}</button>
    </div>
  </div>
</Sheet>

<style>
  .body {
    padding: 26px 26px 22px;
  }
  h2 {
    margin: 0 40px 6px 0;
  }
  p {
    margin: 0;
    color: var(--label-2);
  }
  .actions {
    display: flex;
    gap: 8px;
    margin-top: 20px;
  }
</style>
