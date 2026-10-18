// Polyfills first: module evaluation follows import order, and the Svelte runtime needs them.
import './polyfills';
import { mount } from 'svelte';
import App from './App.svelte';
import { initPlatform } from './platform';

void initPlatform().then(() => mount(App, { target: document.getElementById('app')! }));
