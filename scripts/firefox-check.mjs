import { firefox } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const browser = await firefox.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const server = createServer(async (request, response) => {
  try {
    const relative =
      request.url === '/' ? 'index.html' : normalize((request.url ?? '').split('?')[0]).replace(/^[/\\]+/, '');
    const file = join(process.cwd(), 'dist', relative);
    const content = await readFile(file);
    const mime =
      {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.webmanifest': 'application/manifest+json',
      }[extname(file)] ?? 'application/octet-stream';
    response.setHeader('Content-Type', mime);
    response.end(content);
  } catch {
    response.statusCode = 404;
    response.end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const port = typeof address === 'object' && address ? address.port : 4174;
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'networkidle' });
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
    pageWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
  };
});
await page.screenshot({ path: 'test-results/desktop-firefox.png' });
await browser.close();
server.close();
if (errors.length) throw new Error(errors.join('; '));
if (metrics.alphaPixels < 50) throw new Error('Firefox subtitle canvas is blank');
if (metrics.pageWidth !== metrics.viewportWidth) throw new Error('Firefox page overflows horizontally');
console.log(JSON.stringify(metrics, null, 2));
