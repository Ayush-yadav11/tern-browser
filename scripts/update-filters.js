'use strict';

// Refreshes the filter snapshot shipped with Tern. Run with: npm run update-filters
const fs = require('node:fs');
const path = require('node:path');
const { app, net } = require('electron');
const { ElectronBlocker } = require('@ghostery/adblocker-electron');

app.whenReady().then(async () => {
  try {
    const engine = await ElectronBlocker.fromPrebuiltAdsAndTracking((...args) => net.fetch(...args));
    const out = path.join(__dirname, '..', 'assets', 'engine.bin');
    const data = engine.serialize();
    fs.writeFileSync(out, data);
    console.log(`Wrote ${out} (${(data.length / 1024 / 1024).toFixed(1)} MB)`);
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
