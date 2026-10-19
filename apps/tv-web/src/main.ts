// Polyfills first: module evaluation follows import order, and the Svelte runtime needs them.
import './polyfills';
import './styles/theme.css';
import { mount } from 'svelte';
import App from './App.svelte';
import { setLanguage } from './lib/i18n.svelte';
import { initScreen } from './lib/screen';
import { settings } from './lib/settings.svelte';
import { applyTheme } from './lib/theme';
import { initPlatform } from './platform';

initScreen();
// Before the first paint: the saved theme, not a flash of the default one.
applyTheme(settings.theme.value, settings.accent.value);
setLanguage(settings.language.value);
void initPlatform().then(() => mount(App, { target: document.getElementById('app')! }));
