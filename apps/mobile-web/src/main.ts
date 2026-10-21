import './styles/app.css';
import { mount } from 'svelte';
import App from './App.svelte';
import { setLanguage } from '$tv/i18n.svelte';
import { settings } from '$tv/settings.svelte';
import { applyTheme } from './lib/theme';
import { initUpdates } from './lib/updates.svelte';

// Before the first paint: the saved theme, not a flash of the default one.
applyTheme(settings.theme.value, settings.accent.value);
setLanguage(settings.language.value);
initUpdates();
mount(App, { target: document.getElementById('app')! });
