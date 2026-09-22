// Rasterises icons/icon.svg into the PNG sizes iOS / the manifest need.
import { loadPlaywright, ROOT } from './lib.mjs';
import fs from 'node:fs';
import path from 'node:path';
const { chromium } = loadPlaywright();
const svg = fs.readFileSync(path.join(ROOT, 'icons/icon.svg'), 'utf8');
const b = await chromium.launch();
for (const size of [180, 512]) {
  const p = await b.newPage({ viewport: { width: size, height: size } });
  await p.setContent(`<body style="margin:0">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body>`);
  await p.screenshot({ path: path.join(ROOT, `icons/icon-${size}.png`), omitBackground: true });
}
await b.close();
