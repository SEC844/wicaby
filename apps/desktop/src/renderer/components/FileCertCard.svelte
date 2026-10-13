<script lang="ts">
  // An untrusted or changed WebDAV certificate (file-sources-spec §7.3): shown in full, trusted only on a click.
  // Used by the Add sheet and by Connect / credentials in Settings.
  import type { FileTestResult } from '../../shared/contract';
  import { t } from '../lib/i18n.svelte';
  import Icon from './Icon.svelte';

  let { cert, changed, ontrust }: { cert: NonNullable<FileTestResult['cert']>; changed: boolean; ontrust: () => void } = $props();
</script>

<div class="cert">
  <div class="cert-head"><Icon name="lock" size={16} /> {t(changed ? 'files.tls.changedTitle' : 'files.tls.title')}</div>
  <p>{t(changed ? 'files.tls.changedBody' : 'files.tls.body')}</p>
  <dl>
    <dt>{t('files.tls.subject')}</dt><dd>{cert.subject}</dd>
    <dt>{t('files.tls.issuer')}</dt><dd>{cert.issuer}</dd>
    <dt>{t('files.tls.validity')}</dt><dd>{cert.validFrom} – {cert.validTo}</dd>
    <dt>{t('files.tls.fingerprint')}</dt><dd class="mono fp">{cert.sha256}</dd>
    {#if cert.pinned}<dt>{t('files.tls.previous')}</dt><dd class="mono fp">{cert.pinned}</dd>{/if}
  </dl>
  <button type="button" class="btn" onclick={ontrust}>{t(changed ? 'files.tls.trustNew' : 'files.tls.trust')}</button>
</div>

<style>
  .cert {
    margin-top: 12px;
    padding: 14px;
    border-radius: var(--r-md);
    background: var(--fill-1);
    box-shadow: inset 0 0 0 1px var(--separator);
    font-size: var(--fs-footnote);
  }
  .cert-head {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 600;
    font-size: var(--fs-callout);
  }
  .cert p {
    margin: 6px 0 10px;
    color: var(--label-2);
    line-height: 1.45;
  }
  .cert dl {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 4px 12px;
    margin: 0 0 12px;
  }
  .cert dt {
    color: var(--label-3);
  }
  .cert dd {
    margin: 0;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .fp {
    font-size: 11px;
  }
</style>
