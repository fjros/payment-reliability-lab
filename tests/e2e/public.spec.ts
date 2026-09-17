import { expect, test } from '@playwright/test';

test('public replay has no local API path and handles a stale live bookmark', async ({ page }) => {
  const calls: string[] = [];
  page.on('request', (r) => {
    if (new URL(r.url()).pathname.startsWith('/v1')) calls.push(r.url());
  });
  await page.goto('/#live');
  await expect(page.getByTestId('source')).toContainText('EXPORTED REPLAY');
  await expect(page.getByRole('tab', { name: 'Live API' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Source code/ })).toBeVisible();
  await expect(page.getByRole('tab')).toHaveCount(5);
  await page.getByRole('tab', { name: /^S3/ }).click();
  await expect(page.getByRole('tab', { name: /^S3/ })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('slider').fill('9');
  await expect(page.getByTestId('answer')).toContainText('UNKNOWN');
  await expect(page.getByTestId('bal-reserved')).toHaveText('1250');
  await page.reload();
  await expect(page.getByRole('heading', { level: 2 })).toContainText('know');
  expect(calls).toEqual([]);
});

for (const width of [390, 768, 1440]) {
  test(`public replay fits ${width}px and links to the source`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/#S2');
    await expect(page.getByTestId('source')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await expect(page.getByRole('link', { name: /Engineering decisions/ })).toHaveAttribute('href', /#guarantees/);
  });
}
