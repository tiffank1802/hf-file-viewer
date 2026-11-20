import { expect, test } from '@playwright/test';

const BASE = 'https://github.com/tiffank1802/hf-file-viewer/releases/latest/download';

test.beforeEach(async ({ page }) => {
  // Les tests de l’interface ne dépendent pas du backend documentaire.
  await page.route('**/api/**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ items: [], totalFiles: 0, user: null, ok: true }),
  }));
});

test('bureau : sélection des plateformes, liens publics et navigation au clavier', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Le bouton d’en-tête est remplacé par la navigation mobile.');
  await page.goto('/');
  const trigger = page.getByRole('button', { name: 'Télécharger ENISE Docs pour ordinateur ou mobile' });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Télécharger ENISE Docs' });
  const close = dialog.getByRole('button', { name: 'Fermer la fenêtre de téléchargement' });
  await expect(dialog).toBeVisible();
  await expect(close).toBeFocused();

  // Le focus reste dans la modale et revient sur le bouton d’origine à la fermeture.
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('link', { name: /Toutes les versions GitHub/ })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();

  await dialog.getByRole('button', { name: /Android/ }).click();
  await expect(dialog.getByRole('link', { name: 'Télécharger pour Android (.apk)' }))
    .toHaveAttribute('href', `${BASE}/ENISE-Docs-android-universal.apk`);
  await dialog.getByRole('button', { name: /iPhone et iPad/ }).click();
  await expect(dialog.getByRole('link', { name: 'Télécharger pour iOS (.ipa non signé)' }))
    .toHaveAttribute('href', `${BASE}/ENISE-Docs-ios-unsigned.ipa`);
  await expect(dialog.getByText(/ne s’installe pas directement/)).toBeVisible();
  await dialog.getByRole('button', { name: /macOS/ }).click();
  await expect(dialog.getByRole('link', { name: 'Télécharger pour macOS (.dmg)' }))
    .toHaveAttribute('href', `${BASE}/ENISE-Docs-macos-universal.dmg`);
  await dialog.getByRole('button', { name: /Windows/ }).click();
  await expect(dialog.getByRole('link', { name: 'Télécharger pour Windows (.exe)' }))
    .toHaveAttribute('href', `${BASE}/ENISE-Docs-windows-x64-setup.exe`);
  await expect(dialog.getByRole('link', { name: /Empreintes SHA-256/ }))
    .toHaveAttribute('href', `${BASE}/SHA256SUMS.txt`);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test.describe('mobile Android', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36',
  });

  test('le lien partagé et la navigation mobile ouvrent la version Android', async ({ page }) => {
    await page.goto('/?download=1');
    const dialog = page.getByRole('dialog', { name: 'Télécharger ENISE Docs' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Votre appareil', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('link', { name: 'Télécharger pour Android (.apk)' }))
      .toHaveAttribute('href', `${BASE}/ENISE-Docs-android-universal.apk`);
    expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth)).toBe(true);
    await dialog.getByRole('button', { name: 'Fermer la fenêtre de téléchargement' }).click();
    await page.getByRole('navigation', { name: 'Navigation mobile' }).getByRole('button', { name: 'Installer' }).click();
    await expect(dialog).toBeVisible();
  });
});
