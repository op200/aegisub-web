import { expect, test } from '@playwright/test'

test('loads the editing workspace and renders the active subtitle', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('menubar')).toBeVisible()
  await expect(page.locator('.menu-project')).toContainText('Aegisub Web')
  await expect(page.getByRole('grid')).toBeVisible()
  const editor = page.getByRole('textbox', { name: 'Subtitle text', exact: true })
  await expect(editor).toHaveValue('Welcome to Aegisub Web')
  await editor.fill('Rendered preview')
  await editor.blur()
  await expect(
    page.getByLabel('Subtitle lines').getByText('Rendered preview', { exact: true }),
  ).toBeVisible()

  // 字幕渲染器是 JASSUB（libass），无视频时不渲染预览（与 Aegisub 一致）；
  // 用 Dummy Video 提供视频区后再断言 libass 画面确实画出了字形
  await page.getByRole('menuitem', { name: 'Video', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Use Dummy Video...' }).click()
  const dummyDialog = page.getByRole('dialog', { name: 'Dummy video options' })
  await expect(dummyDialog).toBeVisible()
  await dummyDialog.getByRole('button', { name: 'OK' }).click()

  // JASSUB 的画布已 transferControlToOffscreen，主线程不能直接 getImageData；
  // 用 drawImage 取样到临时 2D 画布统计不透明像素（渲染是异步的，轮询等待）
  const overlay = page.locator('.jassub-canvas')
  await expect(overlay).toBeVisible()
  await expect
    .poll(
      () =>
        overlay.evaluate((source: HTMLCanvasElement) => {
          const probe = document.createElement('canvas')
          probe.width = Math.max(1, source.width)
          probe.height = Math.max(1, source.height)
          const context = probe.getContext('2d')
          if (!context) return 0
          context.drawImage(source, 0, 0)
          const pixels = context.getImageData(0, 0, probe.width, probe.height).data
          let count = 0
          for (let index = 3; index < pixels.length; index += 4) if (pixels[index] > 0) count += 1
          return count
        }),
      { timeout: 15000 },
    )
    .toBeGreaterThan(50)
})

test('opens native-style menus and executes Aegisub shortcuts', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('menuitem', { name: 'File', exact: true }).click()
  await expect(page.getByRole('menuitem', { name: 'New Subtitles' })).toBeVisible()

  await page.keyboard.press('Escape')
  await page.keyboard.press('Control+f')
  await expect(page.getByRole('dialog', { name: 'Find', exact: true })).toBeVisible()
  await page
    .getByRole('dialog', { name: 'Find', exact: true })
    .getByRole('button', { name: 'Close' })
    .click()

  await page.keyboard.press('Control+d')
  await expect(page.getByRole('grid')).toHaveAttribute('aria-rowcount', '2')

  await page.getByRole('menuitem', { name: 'Subtitle', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Styles Manager...' }).click()
  await expect(page.getByRole('dialog', { name: 'Styles Manager' })).toBeVisible()
})

test.describe('mobile layout', () => {
  test.skip(({ isMobile }) => !isMobile, 'Mobile viewport only')
  test('keeps the workspace usable without horizontal page overflow', async ({ page }) => {
    await page.goto('/')
    const dimensions = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }))
    expect(dimensions.scroll).toBe(dimensions.client)
    await expect(page.getByLabel('Video preview')).toBeVisible()
    await expect(page.getByLabel('Line editor')).toBeVisible()
  })
})
