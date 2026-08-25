/**
 * modal-layout.mjs — regression guard for modal scrolling.
 *
 * Before the fix, a tall modal (Close shift with a full Z report, the product
 * form on a 768px laptop) rendered 1147px tall inside a 768px viewport with
 * no scrollbar. The confirm button sat 379px below the fold and could not be
 * reached at all — and because the overlay centred the card, the top was
 * clipped too, so you could not even scroll back up to it.
 *
 * Run:  node tests/modal-layout.mjs
 *
 * Checks, at three viewport sizes:
 *   · the card fits inside the viewport
 *   · the card scrolls internally when content overflows
 *   · the title stays pinned when scrolled to the bottom
 *   · the action buttons stay pinned and reachable
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const CHROME = process.env.CHROME_PATH
  ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const brand = readFileSync('src/styles/brand.css','utf8');
const till  = readFileSync('src/styles/till.css','utf8');

// A deliberately tall modal, mirroring Close shift with a full Z report.
const html = `<!doctype html><html><head><meta charset="utf-8">
<style>${brand}${till}</style></head><body>
<div class="till-block" role="dialog">
  <div class="till-block__card" style="max-width:560px">
    <h2 class="till-block__title">Close shift · TILL-01</h2>
    ${Array.from({length:30},(_,i)=>`<div class="z__row"><span>Row ${i+1}</span><b>1,234.00</b></div>`).join('')}
    <div class="till-actions"><button class="till-btn">Back</button>
      <button class="till-btn till-btn--pay">Close shift</button></div>
  </div>
</div></body></html>`;

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
for (const vp of [{width:1366,height:768},{width:1280,height:600},{width:800,height:450}]) {
  const page = await browser.newPage({ viewport: vp });
  await page.setContent(html);
  await page.waitForTimeout(120);

  const r = await page.evaluate(() => {
    const card = document.querySelector('.till-block__card');
    const title = document.querySelector('.till-block__title');
    const actions = document.querySelector('.till-actions');
    const cb = card.getBoundingClientRect();
    return {
      cardTop: Math.round(cb.top),
      cardBottom: Math.round(cb.bottom),
      viewportH: window.innerHeight,
      cardScrollable: card.scrollHeight > card.clientHeight,
      titleVisible: title.getBoundingClientRect().top >= -1,
      actionsInView: actions.getBoundingClientRect().bottom <= window.innerHeight + 1,
    };
  });

  // Scroll the card to the bottom and re-check the pinned regions.
  await page.evaluate(() => {
    const c = document.querySelector('.till-block__card');
    c.scrollTop = c.scrollHeight;
  });
  await page.waitForTimeout(80);
  const after = await page.evaluate(() => {
    const card = document.querySelector('.till-block__card').getBoundingClientRect();
    const t = document.querySelector('.till-block__title').getBoundingClientRect();
    const a = document.querySelector('.till-actions').getBoundingClientRect();
    return {
      titlePinned: Math.abs(t.top - card.top) < 2,
      actionsPinned: Math.abs(a.bottom - card.bottom) < 2,
    };
  });

  const ok = r.cardTop >= -1 && r.cardBottom <= r.viewportH + 1
          && r.cardScrollable && r.titleVisible && r.actionsInView
          && after.titlePinned && after.actionsPinned;

  if (!ok) process.exitCode = 1;
  console.log(`${vp.width}x${vp.height} ${ok ? '✅' : '❌'} ` +
    `top=${r.cardTop} bottom=${r.cardBottom}/${r.viewportH} ` +
    `scrolls=${r.cardScrollable} titlePinned=${after.titlePinned} ` +
    `actionsPinned=${after.actionsPinned}`);
  await page.close();
}
await browser.close();

if (process.exitCode === 1) {
  console.error('\nModal layout regression. See tests/modal-layout.mjs.');
}
