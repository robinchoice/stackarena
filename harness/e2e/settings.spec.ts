import { TARGET } from './env';
import { expect, test } from './fixtures';

test('the language switches between German and English', async ({ ui }) => {
  await ui.tap('nav.settings');
  await ui.tap('settings.lang.de');
  await expect(ui.el('nav.today')).toHaveText('Heute');
  await ui.tap('settings.lang.en');
  await expect(ui.el('nav.today')).toHaveText('Today');
});

test('signing out leads to the sign-in screen and back', async ({ ui, user }) => {
  await ui.tap('nav.settings');
  await ui.tap('settings.logout');
  await expect(ui.el('login.email')).toBeVisible();
  if (TARGET !== 'mockup') {
    await ui.fill('login.email', user!.email);
    await ui.fill('login.password', 'correct-horse-battery');
  }
  await ui.tap('login.submit');
  await expect(ui.el('today.progress.due')).toBeVisible();
});

test('syncing by hand confirms with a message', async ({ ui }) => {
  await ui.tap('nav.settings');
  await ui.tap('settings.sync');
  await expect(ui.el('toast')).toBeVisible();
});
