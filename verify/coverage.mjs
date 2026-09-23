// Whitewater coverage of screenshots: fraction of pixels that are bright and
// near-neutral (foam white), and that fraction relative to water pixels
// (teal-dominant or white). usage: node verify/coverage.mjs a.png b.png ...
import { loadPlaywright, launch } from './lib.mjs';
import fs from 'node:fs';
const { chromium } = loadPlaywright();
const browser = await launch(chromium);
const page = await browser.newPage();
for (const f of process.argv.slice(2)) {
  const uri = 'data:image/png;base64,' + fs.readFileSync(f).toString('base64');
  const r = await page.evaluate(async (src) => {
    const img = await new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = src; });
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const x = c.getContext('2d'); x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    let white = 0, water = 0;
    for (let k = 0; k < d.length; k += 4) {
      const R = d[k], G = d[k + 1], B = d[k + 2], mx = Math.max(R, G, B), mn = Math.min(R, G, B);
      const isWhite = mn > 140 && mx - mn < 45;
      const isWater = isWhite || (G > R + 8 && B > R + 8);
      if (isWhite) white++;
      if (isWater) water++;
    }
    return { white: white / (d.length / 4), ofWater: white / Math.max(1, water) };
  }, uri);
  console.log(f, 'white', (r.white * 100).toFixed(1) + '%', 'of water', (r.ofWater * 100).toFixed(1) + '%');
}
await browser.close();
