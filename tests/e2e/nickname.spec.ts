import { expect, test, type Page } from '@playwright/test';

/**
 * Curated E2E (ticket 13, spec §2.8): the join card's nickname pre-check in a
 * real browser — the live hint, the refusal, and the guest name a nameless join
 * is given.
 *
 * The rule itself is pinned headlessly: the filter and blocklist in
 * `shared/nickname.test.ts`, the wording in `client/game/nickname-hint.test.ts`
 * and the server's enforcement against raw join frames in
 * `server/arena.test.ts` — which is the only layer where a manipulated client
 * can actually be built. What only a browser can show is that the three are
 * wired to the card at all.
 */

const HINT = '#name-hint';

async function open(page: Page): Promise<void> {
  await page.goto('/');
  // Enabled only once main.ts is wired — waiting for it is what makes the
  // typing below land on a live `input` listener.
  await expect(page.locator('#join-form button')).toBeEnabled();
}

test('says nothing about an ordinary name', async ({ page }) => {
  await open(page);
  await page.fill('#name', 'Ada');
  await expect(page.locator(HINT)).toHaveText('');
});

test('warns about a blocked name, then lets the server replace it', async ({ page }) => {
  await open(page);
  await page.fill('#name', 'nazi');
  const hint = page.locator(HINT);
  await expect(hint).toHaveText('Dieser Name ist nicht erlaubt — du spielst als Gast.');
  await expect(hint).toHaveClass(/blocked/);

  // The card does NOT gate the join (ticket 13: the client only pre-checks) —
  // the game starts, and the name on the board is the server's, not the typed
  // one. This is the whole trust model in a single flow.
  await page.click('#join-form button');
  await expect(page.locator('#overlay')).toBeHidden({ timeout: 15_000 });
  await expect(page.locator('#leaderboard li.row.self .name')).toHaveText(/^Gast-\d{4}$/, {
    timeout: 10_000,
  });
});

test('previews the name it will actually show', async ({ page }) => {
  await open(page);
  // A zero-width space between the letters: invisible in the field, gone from
  // the name. It survives every length check, which is the point of showing it.
  await page.fill('#name', 'A\u200Bda');
  await expect(page.locator(HINT)).toHaveText('Wird angezeigt als „Ada".');
});

test('a nameless join gets a numbered guest name from the server', async ({ page }) => {
  await open(page);
  await page.click('#join-form button');
  await expect(page.locator('#overlay')).toBeHidden({ timeout: 15_000 });

  // Read off the leaderboard: `Gast-####` is numbered by player id, which only
  // the server knows — so this also proves the client sent no name of its own.
  await expect(page.locator('#leaderboard li.row.self .name')).toHaveText(/^Gast-\d{4}$/, {
    timeout: 10_000,
  });
});
