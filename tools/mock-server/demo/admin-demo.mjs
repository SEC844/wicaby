// Demo-mode text for the admin mock modules (../mock-admin/*.mjs): activity log titles, folder browser
// entries and server log lines (see ADMIN in demo-dataset.mjs). Null unless MOCK_DATASET=demo, so the
// stock mock never loads demo-dataset.mjs (which needs ATTRIBUTION.json).
export const DEMO_ADMIN = process.env.MOCK_DATASET === 'demo' ? (await import('./demo-dataset.mjs')).ADMIN : null;
