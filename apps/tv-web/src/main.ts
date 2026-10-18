// Polyfills first: module evaluation follows import order, and the Svelte runtime needs them.
import './polyfills';
import './styles/theme.css';
import { mount } from 'svelte';
import App from './App.svelte';
import { setLanguage } from './lib/i18n.svelte';
import { initScreen } from './lib/screen';
import { initPlatform } from './platform';

initScreen();
setLanguage('auto');
void initPlatform().then(() => mount(App, { target: document.getElementById('app')! }));
