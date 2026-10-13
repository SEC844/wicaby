import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './app.css';
import { mount } from 'svelte';
import App from './App.svelte';

const params = new URLSearchParams(location.search);
if (params.get('mica') === '1') document.documentElement.classList.add('mica');
if (params.get('osd') === '1') document.documentElement.classList.add('osd');
if (params.get('mini') === '1') document.documentElement.classList.add('mini');
if (params.get('linux') === '1') document.documentElement.classList.add('linux');

window.addEventListener('error', (e) => window.wicaby?.app.log('error', `${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => window.wicaby?.app.log('error', `unhandled: ${String(e.reason?.stack ?? e.reason)}`));

mount(App, { target: document.getElementById('app')! });
