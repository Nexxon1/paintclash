import { expect, test, type Page } from '@playwright/test';

/**
 * Curated E2E (ticket 14, spec §2.6): the private-room flow in a real browser —
 * create a room, copy its link, join through it, and start the game from the
 * lobby. What only a browser can show is that the card actually swaps between
 * the join form and the lobby, that the link a host shares works when it is
 * *followed*, and that the settings are inert for anyone but the host.
 *
 * The rules themselves are pinned a layer down: the code format and the settings
 * policy in `shared/room.test.ts`, the display model in `client/game/room.test.ts`,
 * and the whole lifecycle over the real wire in `tests/scenario/room.test.ts` —
 * which is the only place a manipulated client can be built.
 */

const LOBBY = '#lobby';
const JOIN_CARD = '#join-card';

/**
 * The room-code alphabet, spelled out because these specs cannot import the
 * workspace packages. It is `ROOM_CODE.alphabet` (`shared/room.ts`): digits 2–9
 * and A–Z without the confusables `I`, `L` and `O` (spec §8.3).
 */
const CODE = '[2-9A-HJKMNP-Z]{6}';

async function open(page: Page, url = '/'): Promise<void> {
  await page.goto(url);
  // Enabled only once main.ts is wired — waiting for it is what makes the
  // clicks below land on live listeners.
  await expect(page.locator('#join-form button')).toBeEnabled();
}

/** Create a room and return the link the card offers for sharing. */
async function createRoom(page: Page, name: string): Promise<string> {
  await open(page);
  await page.fill('#name', name);
  await page.click('#create-room');
  await expect(page.locator(LOBBY)).toBeVisible({ timeout: 15_000 });
  const link = await page.locator(`${LOBBY} .room-link`).inputValue();
  expect(link).toMatch(new RegExp(`\\?room=${CODE}$`));
  return link;
}

test('a host creates a room, sees the lobby and can share a link', async ({ page }) => {
  const link = await createRoom(page, 'Gastgeberin');

  // The lobby replaces the join form — a client in a lobby is waiting, not
  // playing, and the overlay stays up until the game starts.
  await expect(page.locator(JOIN_CARD)).toBeHidden();
  await expect(page.locator('#overlay')).toBeVisible();

  // The code is shown big, and it is the code in the link.
  const code = await page.locator(`${LOBBY} .room-code`).textContent();
  expect(link).toContain(`?room=${String(code)}`);

  // The host is the only member, marked as host, in the reserved own-blue.
  const members = page.locator(`${LOBBY} .member`);
  await expect(members).toHaveCount(1);
  await expect(members.locator('.name')).toHaveText('Gastgeberin');
  await expect(members.locator('.host')).toHaveText('Host');
  await expect(members).toHaveClass(/self/);
  const swatch = await members
    .locator('.swatch')
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(swatch).toBe('rgb(47, 127, 232)');

  // The host's controls are live, and the settings show the spec's defaults for
  // eight players (§10.4: 8 → 200 WU, bots off, late join on).
  await expect(page.locator(`${LOBBY} .room-start`)).toBeVisible();
  const settings = page.locator(`${LOBBY} .room-settings input`);
  for (const input of await settings.all()) await expect(input).toBeEnabled();
  await expect(page.locator(`${LOBBY} .room-settings input`).nth(0)).toHaveValue('8');
  await expect(page.locator(`${LOBBY} .room-settings input`).nth(1)).toHaveValue('200');
  await expect(page.locator(`${LOBBY} .room-settings input`).nth(2)).toHaveValue('0');
  // Late join is ON by default (spec §2.6: "Toggle, Default an — Drop-in per Link").
  await expect(page.locator(`${LOBBY} .room-settings input`).nth(3)).toBeChecked();
});

test('a shared link leads into the lobby, and the host starts the game', async ({ browser }) => {
  const hostPage = await (await browser.newContext()).newPage();
  const guestPage = await (await browser.newContext()).newPage();
  try {
    const link = await createRoom(hostPage, 'Gastgeberin');

    // The guest FOLLOWS the link — the code is prefilled from it, and the room
    // row leads the card because that is what they came for.
    await open(guestPage, link);
    await expect(guestPage.locator('#room-code')).toHaveValue(new RegExp(`^${CODE}$`));
    await expect(guestPage.locator(JOIN_CARD)).toHaveClass(/linked/);
    await guestPage.fill('#name', 'Gast');
    await guestPage.click('#join-room');
    await expect(guestPage.locator(LOBBY)).toBeVisible({ timeout: 15_000 });

    // Both sides see both members, and only the creator is host.
    await expect(hostPage.locator(`${LOBBY} .member`)).toHaveCount(2, { timeout: 10_000 });
    await expect(guestPage.locator(`${LOBBY} .member`)).toHaveCount(2);
    await expect(hostPage.locator(`${LOBBY} .room-count`)).toHaveText('2 / 8 Spieler');
    await expect(guestPage.locator(`${LOBBY} .member.self .name`)).toHaveText('Gast');
    await expect(guestPage.locator(`${LOBBY} .member.self .host`)).toHaveCount(0);

    // The guest has no start button, and the settings are inert for them — the
    // server enforces it either way, the card just does not promise a control
    // that does nothing.
    await expect(guestPage.locator(`${LOBBY} .room-start`)).toBeHidden();
    for (const input of await guestPage.locator(`${LOBBY} .room-settings input`).all()) {
      await expect(input).toBeDisabled();
    }

    // A setting the host changes reaches the guest's card.
    await hostPage.locator(`${LOBBY} .room-settings input`).nth(1).fill('120');
    await hostPage.locator(`${LOBBY} .room-settings input`).nth(1).blur();
    await expect(guestPage.locator(`${LOBBY} .room-settings input`).nth(1)).toHaveValue('120', {
      timeout: 10_000,
    });

    // Host-Start (spec §2.6): both overlays go away and both are in the game.
    await hostPage.click(`${LOBBY} .room-start`);
    await expect(hostPage.locator('#overlay')).toBeHidden({ timeout: 15_000 });
    await expect(guestPage.locator('#overlay')).toBeHidden({ timeout: 15_000 });
    // One arena, two players — each sees the other on the shared board. Anchored
    // names: "Gast" is a substring of "Gastgeberin".
    await expect(
      hostPage.locator('#leaderboard li.row .name').filter({ hasText: /^Gast$/ }),
    ).toHaveCount(1, { timeout: 10_000 });
    await expect(
      guestPage.locator('#leaderboard li.row .name').filter({ hasText: /^Gastgeberin$/ }),
    ).toHaveCount(1);
  } finally {
    await hostPage.close();
    await guestPage.close();
  }
});

test('a code nobody is using is refused with a reason', async ({ page }) => {
  await open(page);
  await page.fill('#name', 'Verirrt');
  // A well-formed code (it passes the client's own pre-check) that names no
  // room: the player has to be told to check the code, not left on a spinner.
  await page.fill('#room-code', 'ZZZZZZ');
  await page.click('#join-room');
  await expect(page.locator('#status')).toHaveText(/Raum gibt es nicht/, { timeout: 15_000 });
  await expect(page.locator(LOBBY)).toBeHidden();
  await expect(page.locator(JOIN_CARD)).toBeVisible();
});

test('a code that could not be one never opens a socket', async ({ page }) => {
  await open(page);
  await page.fill('#room-code', 'nope');
  await page.click('#join-room');
  // The client checks the shared rule first (`normalizeRoomCode`), so this is a
  // hint in the card rather than a round trip that ends in a 400.
  await expect(page.locator('#status')).toHaveText(/6 Zeichen/);
  await expect(page.locator(LOBBY)).toBeHidden();
});
