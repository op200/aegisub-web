import { chromium } from 'playwright';

const baseURL = process.env.AEGISUB_PREVIEW_URL ?? 'http://127.0.0.1:4173';

async function inspect(browserType, name, viewport, mobile = false) {
  const browser = await browserType.launch({
    headless: true,
    ...(process.env.AEGISUB_CHROME_CHANNEL ? { channel: process.env.AEGISUB_CHROME_CHANNEL } : {}),
  });
  const context = await browser.newContext(mobile ? { viewport, isMobile: true, hasTouch: true } : { viewport });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(baseURL, { waitUntil: 'networkidle' });
  await page.locator('.app-shell').waitFor();
  const metrics = await page.evaluate(() => {
    const canvas = document.querySelector('.subtitle-overlay');
    const canvasContext = canvas?.getContext('2d');
    let alphaPixels = 0;
    if (canvas && canvasContext) {
      const pixels = canvasContext.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let index = 3; index < pixels.length; index += 4) if (pixels[index]) alphaPixels += 1;
    }
    return {
      alphaPixels,
      viewportWidth: document.documentElement.clientWidth,
      pageWidth: document.documentElement.scrollWidth,
      gridRows: document.querySelectorAll('.subtitle-row').length,
    };
  });
  await page.screenshot({ path: `test-results/${name}.png`, fullPage: mobile });
  await browser.close();
  if (errors.length) throw new Error(`${name} page errors: ${errors.join('; ')}`);
  if (metrics.alphaPixels < 50) throw new Error(`${name} subtitle canvas is blank`);
  if (metrics.pageWidth !== metrics.viewportWidth) throw new Error(`${name} page overflows horizontally`);
  return metrics;
}

const results = {
  chromium: await inspect(chromium, 'desktop-chromium', { width: 1440, height: 900 }),
  mobile: await inspect(chromium, 'mobile-chromium', { width: 412, height: 915 }, true),
};

console.log(JSON.stringify(results, null, 2));
