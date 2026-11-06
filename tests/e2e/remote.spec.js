import { test, expect, chromium } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const serverUrl = 'http://127.0.0.1:4031';
const executablePath = process.env.MOTRO_CHROME_PATH;

async function expectSingleScreen(page, remote = false) {
  await expect.poll(() => page.evaluate((isRemote) => {
    const viewport = window.visualViewport?.height ?? innerHeight;
    const ids = isRemote ? ['disconnect', 'trackpad', 'scroll-mode', 'reset-zoom', 'speed'] : ['code', 'connect', 'visit-count', 'app-version'];
    const controlsFit = ids.every((id) => {
      const rect = document.getElementById(id).getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= viewport + 1 && rect.left >= 0 && rect.right <= innerWidth + 1;
    });
    const pad = document.getElementById('trackpad').getBoundingClientRect();
    return controlsFit && document.documentElement.scrollHeight <= viewport + 1
      && document.documentElement.scrollWidth <= innerWidth + 1
      && (!isRemote || pad.height >= viewport * 0.6);
  }, remote)).toBe(true);
}

test('phone pairs with real extension and controls scrolling and native zoom', async () => {
  const profile = await mkdtemp(path.join(tmpdir(), 'motro-e2e-'));
  const extensionPath = path.resolve('apps/extension');
  let desktop;
  let phoneBrowser;
  let target;
  try {
    desktop = await chromium.launchPersistentContext(profile, {
      ...(executablePath ? { executablePath } : { channel: 'chromium' }),
      headless: true,
      ignoreDefaultArgs: ['--disable-extensions'],
      args: executablePath ? ['--enable-unsafe-extension-debugging']
        : [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    });
    if (executablePath) {
      // Existing tabs need the on-demand content-script fallback after installation.
      target = await desktop.newPage();
      await target.goto(serverUrl);
      const cdp = await desktop.browser().newBrowserCDPSession();
      await cdp.send('Extensions.loadUnpacked', { path: extensionPath });
      await cdp.detach();
    }
    const worker = desktop.serviceWorkers()[0] || await desktop.waitForEvent('serviceworker');
    await worker.evaluate((url) => chrome.storage.local.set({ serverUrlOverride: url }), serverUrl);
    const extensionId = new URL(worker.url()).hostname;
    const popup = await desktop.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect.poll(() => popup.locator('.brand-icon').evaluate((image) => image.naturalWidth)).toBe(128);
    await expect(popup.locator('#app-version')).toHaveText(/^v\d+\.\d+\.\d+$/);
    await expect(popup.locator('#start-view')).toBeVisible();
    await expect(popup.locator('#stop')).toBeHidden();
    await popup.locator('#start').click();
    await expect(popup.locator('#code')).toHaveText(/^\d{4}$/);
    const oldCode = await popup.locator('#code').textContent();
    await popup.locator('#refresh').click();
    await expect(popup.locator('#code')).not.toHaveText(oldCode);
    const code = await popup.locator('#code').textContent();
    await expect(popup.locator('#qr')).toBeVisible();
    expect(await popup.locator('#code').evaluate((element) => {
      const code = element.getBoundingClientRect();
      const row = element.parentElement.getBoundingClientRect();
      return Math.abs((code.left + code.right) / 2 - (row.left + row.right) / 2);
    })).toBeLessThan(1);
    const scanUrl = new URL(await popup.locator('#qr').getAttribute('data-url'));
    expect(new URLSearchParams(scanUrl.hash.slice(1)).get('code')).toBe(code);
    expect(await popup.locator('#qr').evaluate((canvas) => canvas.width)).toBeGreaterThan(100);
    await expect(popup.locator('#copy-url, #phone-url')).toHaveCount(0);
    await expect(popup.locator('#pair-view')).not.toContainText('http');
    await popup.screenshot({ path: 'test-results/extension-code.png' });

    // The controlled page is a real HTTP tab, not a privileged browser page.
    if (!target) {
      target = await desktop.newPage();
      await target.goto(serverUrl);
    }
    await expect(target.locator('#visit-count')).toHaveText(/^no\.\d+$/);
    await target.evaluate(() => {
      document.documentElement.style.overflow = 'auto';
      document.body.style.position = 'static';
      document.body.style.height = 'auto';
      document.body.style.overflow = 'visible';
      const space = document.createElement('div');
      space.style.height = '6000px';
      document.body.append(space);
    });

    phoneBrowser = await chromium.launch(executablePath ? { executablePath } : {});
    const phoneContext = await phoneBrowser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const phone = await phoneContext.newPage();
    const pageErrors = [];
    phone.on('pageerror', (error) => pageErrors.push(error.message));
    await phone.goto(serverUrl);
    await expect(phone.locator('#visit-count')).toHaveText(/^no\.\d+$/);
    const firstVisit = Number((await phone.locator('#visit-count').textContent()).slice(3));
    await expect(phone.locator('#app-version')).toHaveText(await popup.locator('#app-version').textContent());
    await expect.poll(() => phone.locator('.brand-icon').evaluate((image) => image.naturalWidth)).toBe(128);
    for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 420 }, { width: 844, height: 390 }, { width: 390, height: 844 }]) {
      await phone.setViewportSize(viewport);
      await expectSingleScreen(phone);
    }
    await phone.screenshot({ path: 'test-results/mobile-pair.png' });
    await phone.locator('#code').fill(code);
    await phone.locator('#connect').click();
    await expect(phone.locator('#waiting-view')).toBeVisible();
    await expect(phone.locator('#waiting-status')).toHaveText('在电脑上确认授权');
    await expect(phone.locator('#pair-view')).toBeHidden();
    await expect(popup.locator('#approval')).toBeVisible();
    await expect(popup.locator('#pair-view')).toBeHidden();
    await popup.screenshot({ path: 'test-results/extension-approval.png' });
    await popup.locator('#deny').click();
    await expect(phone.locator('#pair-view')).toBeVisible();
    await expect(popup.locator('#pair-view')).toBeVisible();
    // A camera opens the scanned link as a document, not an in-page hash jump.
    await phone.goto('about:blank');
    await phone.goto(serverUrl + scanUrl.hash);
    await expect(phone.locator('#waiting-view')).toBeVisible();
    expect(new URL(phone.url()).hash).toBe('');
    await expect(popup.locator('#approval')).toBeVisible();
    await popup.locator('#allow').click();
    await expect(phone.locator('#remote-view')).toBeVisible();
    await expect(phone.locator('#remote-status')).toContainText('已连接');
    await expect(popup.locator('#connection-status')).toHaveText('连接中');
    await expect(popup.locator('#stop')).toHaveText('结束连接');
    await expect(popup.locator('#pair-view')).toBeHidden();
    await popup.screenshot({ path: 'test-results/extension-connected.png' });
    for (const viewport of [{ width: 320, height: 568 }, { width: 360, height: 640 }, { width: 390, height: 420 }, { width: 844, height: 390 }, { width: 768, height: 1024 }, { width: 390, height: 844 }]) {
      await phone.setViewportSize(viewport);
      await expectSingleScreen(phone, true);
    }

    // A popup can close without interrupting the service-worker connection.
    await popup.close();
    await target.bringToFront();
    // Cross Chrome's normal 30-second worker idle window without interaction.
    await phone.waitForTimeout(35_000);
    await expect(phone.locator('#remote-status')).toHaveText('已连接');
    const pad = phone.locator('#trackpad');
    const box = await pad.boundingBox();
    const touch = await phoneContext.newCDPSession(phone);
    const point = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...point, id: 1 }] });
    await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x, y: point.y - 100, id: 1 }] });
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(() => target.evaluate(() => scrollY)).toBeGreaterThan(80);

    // Deliberate time gaps model a swipe velocity rather than waiting for UI state.
    const beforeFling = await target.evaluate(() => scrollY);
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...point, id: 1 }] });
    for (const offset of [30, 60, 90, 120]) {
      await phone.waitForTimeout(20);
      await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x, y: point.y - offset, id: 1 }] });
    }
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(() => target.evaluate(() => scrollY)).toBeGreaterThan(beforeFling + 215);
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...point, id: 1 }] });
    // Touch stops emitting momentum immediately; Chromium may finish an in-flight native wheel animation.
    await expect.poll(async () => {
      const before = await target.evaluate(() => scrollY);
      await phone.waitForTimeout(100);
      return (await target.evaluate(() => scrollY)) - before;
    }, { timeout: 2000 }).toBe(0);
    const stoppedAt = await target.evaluate(() => scrollY);
    await phone.waitForTimeout(120);
    expect(await target.evaluate(() => scrollY)).toBe(stoppedAt);
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

    // A two-axis DOM scroller remains controlled at the center, not the actual mouse.
    expect(await worker.evaluate(() => chrome.runtime.getManifest().permissions.includes('debugger'))).toBe(false);
    await target.evaluate(() => {
      const panel = document.createElement('div');
      panel.id = 'wide-target';
      panel.style.cssText = 'position:fixed;inset:20%;overflow:auto;z-index:9999;background:#eee';
      const content = document.createElement('div');
      content.style.cssText = 'width:5000px;height:5000px';
      panel.append(content); document.body.append(panel);
    });
    await target.mouse.move(5, 5);
    const swipe = async (dx, dy) => {
      await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...point, id: 1 }] });
      await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x + dx, y: point.y + dy, id: 1 }] });
      await phone.waitForTimeout(100);
      await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    const position = () => target.locator('#wide-target').evaluate((el) => ({ x: el.scrollLeft, y: el.scrollTop }));
    await expect(phone.locator('#scroll-mode')).toHaveText('上下');
    await swipe(-40, -100);
    await expect.poll(async () => (await position()).y).toBeGreaterThan(80);
    expect((await position()).x).toBe(0);
    await phone.locator('#scroll-mode').click();
    await expect(phone.locator('#scroll-mode')).toHaveText('左右');
    const beforeHorizontal = await position();
    await swipe(-100, -40);
    await expect.poll(async () => (await position()).x).toBeGreaterThan(80);
    expect((await position()).y).toBe(beforeHorizontal.y);
    await swipe(100, 0);
    await expect.poll(async () => (await position()).x).toBeLessThan(30);
    const speed = Number(await phone.locator('#speed').inputValue());
    const beforeStream = (await position()).x;
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...point, id: 1 }] });
    for (let offset = 5; offset <= 100; offset += 5) {
      await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x - offset, y: point.y, id: 1 }] });
    }
    await phone.waitForTimeout(100);
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(async () => (await position()).x).toBeCloseTo(beforeStream + 100 * speed, 0);
    await phone.locator('#scroll-mode').click();
    const beforeVertical = await position();
    await swipe(0, -100);
    await expect.poll(async () => (await position()).y).toBeGreaterThan(beforeVertical.y + 80);
    expect((await position()).x).toBeCloseTo(beforeVertical.x, 0);
    await target.locator('#wide-target').evaluate((element) => element.remove());

    // A horizontal-only child must never trap subsequent vertical input to its parent.
    await target.evaluate(() => {
      const parent = document.createElement('div');
      parent.id = 'nested-target';
      parent.style.cssText = 'position:fixed;inset:20%;overflow:auto;z-index:9999;background:#eee';
      const child = document.createElement('div');
      child.id = 'horizontal-child';
      child.style.cssText = 'position:sticky;top:0;width:100%;height:100%;overflow-x:auto;overflow-y:hidden';
      const wide = document.createElement('div');
      wide.style.cssText = 'width:5000px;height:100%';
      child.append(wide);
      const spacer = document.createElement('div');
      spacer.style.height = '5000px';
      parent.append(child, spacer); document.body.append(parent);
    });
    for (let i = 0; i < 3; i++) {
      await phone.locator('#scroll-mode').click();
      const x = await target.locator('#horizontal-child').evaluate((el) => el.scrollLeft);
      await swipe(-100, 0);
      await expect.poll(() => target.locator('#horizontal-child').evaluate((el) => el.scrollLeft)).toBeGreaterThan(x + 80);
      await phone.locator('#scroll-mode').click();
      const y = await target.locator('#nested-target').evaluate((el) => el.scrollTop);
      await swipe(0, -100);
      await expect.poll(() => target.locator('#nested-target').evaluate((el) => el.scrollTop)).toBeGreaterThan(y + 80);
      await swipe(0, 100);
      await expect.poll(() => target.locator('#nested-target').evaluate((el) => el.scrollTop)).toBeLessThan(y + 30);
    }
    await target.locator('#nested-target').evaluate((element) => element.remove());

    const zoom = () => worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      return chrome.tabs.getZoom(tab.id);
    });
    await phone.locator('#zoom-in').click();
    await expect.poll(zoom).toBeGreaterThan(1);
    await phone.locator('#reset-zoom').click();
    await expect.poll(zoom).toBe(1);

    // Exercise actual multi-touch pinch, not just the +/- fallback buttons.
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [
      { x: point.x - 30, y: point.y, id: 1 }, { x: point.x + 30, y: point.y, id: 2 },
    ] });
    await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [
      { x: point.x - 60, y: point.y, id: 1 }, { x: point.x + 60, y: point.y, id: 2 },
    ] });
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(zoom).toBeGreaterThan(1.2);

    await phone.locator('#scroll-mode').click();
    await expect(phone.locator('#scroll-mode')).toHaveText('左右');
    await phone.reload();
    await expect(phone.locator('#remote-status')).toContainText('已连接');
    await expect(phone.locator('#scroll-mode')).toHaveText('左右');
    await expect.poll(async () => Number((await phone.locator('#visit-count').textContent()).slice(3))).toBe(firstVisit + 2);
    await phone.screenshot({ path: 'test-results/mobile-connected.png', fullPage: true });
    await phone.locator('#disconnect').click();
    await expect(phone.locator('#pair-view')).toBeVisible();
    await expect.poll(() => worker.evaluate(async () => (await chrome.storage.session.get('motro')).motro.paired)).toBe(false);
    expect(pageErrors).toEqual([]);
  } finally {
    await phoneBrowser?.close();
    await desktop?.close();
    await rm(profile, { recursive: true, force: true });
  }
});
