import { test, expect } from '@playwright/test';

async function login(page) {
  const u = process.env.AUTH_USERNAME || 'test';
  const p = process.env.AUTH_PASSWORD || 'test';
  await page.goto('/en/login');
  await page.getByLabel('Username').fill(u);
  await page.getByLabel('Password').fill(p);
  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page).toHaveURL(/\/(en|de)(\/)?$/);
}

test('refresh button disables during action and prevents double submit', async ({ page }) => {
  await login(page);
  await page.goto('/en');

  const refreshBtn = page.getByRole('button', { name: 'Refresh' });
  await expect(refreshBtn).toBeEnabled();

  // Click twice quickly; second should be ignored because disabled during pending
  await Promise.all([
    refreshBtn.click(),
    refreshBtn.click(),
  ]);

  await expect(refreshBtn).toBeDisabled();

  // Button should return to enabled state after operation completes.
  // This is the reliable end signal; toast rendering can be flaky in CI.
  await expect(refreshBtn).toBeEnabled({ timeout: 15_000 });
});
