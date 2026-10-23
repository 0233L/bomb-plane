# Web Probe Confirmation (`bp_reveal_confirm`)

> Executable contract for the “二次确认” checkbox above the enemy board in
> `public/`. The offline Xiaoheihe copy implements the same interaction; see
> [xiaoheihe-sandbox.md](./xiaoheihe-sandbox.md#probe-confirmation-contract).

## 1. Scope / Trigger

Apply this spec when touching:

- `public/index.html`: `#reveal-confirm-wrap`, `#reveal-confirm`,
  `#board-title-enemy-note`
- `public/client.js`: `state.revealConfirm`, `state.revealPending`,
  `loadRevealConfirm()`, `updateRevealConfirmUI()`, `onRevealConfirmChange()`,
  `clearRevealPending()`, `onEnemyCellClick()`, `renderBattleBoards()`
- `public/style.css`: `.reveal-confirm-label`, `#enemy-board td.cell-probe-target`
- storage key `bp_reveal_confirm`
- the permanent test `test/reveal-confirm-test.js`

This feature is client-only. It must not send new socket events, change
`server.js`, `ai.js`, or `miniprogram/`, or alter the item protocol.

## 2. Signatures

```js
// state
state.revealConfirm = false;   // boolean, persisted separately
state.revealPending = null;    // { row: number, col: number } | null

loadRevealConfirm();                 // init(): safeGet('bp_reveal_confirm') === '1'
updateRevealConfirmUI();             // sync checkbox, visibility, note text
clearRevealPending();                // drop the unconfirmed target
onRevealConfirmChange(checked);      // checkbox 'change' handler
onEnemyCellClick(row, col);          // click handler; item branch runs first
```

Storage: `safeSet('bp_reveal_confirm', '1' | '0')`. An unset or invalid value
means **off**.

## 3. Contracts

- Default is off; the note reads
  `（点击未知格子揭示 · 右键/长按可标注机身）`.
- When on, the first tap on an eligible unknown cell:
  - sets `revealPending = {row, col}`;
  - does **not** emit `reveal` and does not change steps;
  - re-renders so that cell has `.cell-probe-target`;
  - toasts `再点一次这个格子确认探测`.
- Tapping a different cell replaces the target. Tapping the same cell again
  clears pending, removes the highlight, adds `.cell-pending`, and emits exactly
  one `reveal {row, col}`.
- When off, the first tap emits `reveal` immediately (old behavior).
- The item branch is checked **before** the confirm branch:
  `if (state.itemPick) return pickItemCell(r, c);`. Item targeting, its own
  second-tap confirmation, and item request payloads never read or write
  `revealPending`. Entering item mode clears any pending normal target.
- Existing guards still apply before the confirm branch: spectator, game over,
  frozen cell, already-revealed cell, and step-leading. None of them may set a
  pending target.
- `updateRevealConfirmUI()`:
  - sets `box.checked = !!state.revealConfirm`;
  - hides `#reveal-confirm-wrap` when `state.spectator || state.over`;
  - when not over, switches `#board-title-enemy-note` between the normal hint
    and `（二次确认已开启：连点同一格两次才会探测）`.
- `renderBattleBoards()` adds `.cell-probe-target` only when pending matches the
  cell and the player is not a spectator, the game is not over, and no item is
  being picked.
- `clearRevealPending()` runs from `clearItemPick()` (therefore `goBattle`,
  `goOver`, item entry, item cancel) and on toggle changes. A highlight must
  never survive a new game, game over, item mode, or a page change.
- The checkbox is inside the enemy board `<h3>`; the title stays centered and
  the label is absolutely positioned at the right edge. On narrow screens the
  label must not overflow the title area or cover the title text.

## 4. Validation & Error Matrix

| Condition | Expected behavior |
|---|---|
| Storage unset / `'0'` / garbage | checkbox unchecked, immediate reveal |
| Storage `'1'` | checkbox checked after reload, note shows the confirm hint |
| First tap, confirm on | pending set, no `reveal`, no step change, dashed outline |
| Second tap, same cell | pending cleared, exactly one `reveal`, highlight replaced by `.cell-pending` |
| Tap another cell | pending retargeted, no `reveal`, no step change |
| Spectator | tap rejected before pending; checkbox hidden; item panel unavailable |
| Game over | tap rejected; checkbox hidden; pending cleared by `goOver` |
| Frozen / already revealed / step-leading | rejected before pending; no highlight |
| Item mode active | click goes to `pickItemCell`; no normal pending/highlight |
| Enter item mode with pending set | pending cleared |
| Toggle off while pending | pending cleared and board re-rendered |
| New game / rematch | pending cleared, checkbox state preserved from storage |
| Missing DOM nodes (`#reveal-confirm`, wrap, note) | helper returns without throwing (`if (!box || !wrap) return`) |

## 5. Good / Base / Bad Cases

- **Good**: user enables 二次确认, taps (3,4) once (highlight only), taps (3,4)
  again (reveal fires once), then disables it; the next tap reveals immediately.
- **Base**: first-time visitor never touches the checkbox; every tap reveals
  immediately exactly as before the feature.
- **Bad**: enabling the mode for item picks, emitting `reveal` on the first tap,
  keeping the highlight after switching to an item or ending the game, or
  hiding the checkbox only visually while still accepting a pending target.

## 6. Tests Required

Permanent jsdom test `test/reveal-confirm-test.js` (39 assertions) covers:

- default off and immediate reveal;
- toggle on → first tap sets pending with no emit; highlight present;
- retarget on a different cell; second same-cell tap emits once with the right
  coordinates and clears the highlight;
- toggle off clears pending and highlights;
- localStorage writes `'1'` / `'0'` and reloads correctly;
- spectator / over hide the checkbox and skip pending;
- frozen / revealed / step-leading guards do not set pending;
- item mode routes to `pickItemCell` and clears a pre-existing pending target;
- enemy note changes only when the toggle is on and the player is not a
  spectator.

Browser check (Puppeteer, mobile 390×844 and desktop 1000×900):

- toggling works end to end against the real server;
- item flow (探测者) still costs one step, deducts coins, and shows no normal
  probe highlight;
- reload remembers the choice via localStorage;
- checkbox does not overflow, title stays centered, no horizontal scroll;
- boards align on desktop and do not overlap when stacked on mobile.

Run the neighboring regressions too: `home-ui-test.js`,
`double-tap-confirm-test.js`, `item-render-test.js`, `sonar-render-test.js`.

## 7. Wrong vs Correct

### Wrong: check the toggle after the item branch has already returned

```js
function onEnemyCellClick(r, c) {
  if (state.revealConfirm) { /* set pending */ }
  if (state.itemPick) return pickItemCell(r, c); // item selection now blocked
}
```

### Correct: item selection stays first

```js
function onEnemyCellClick(r, c) {
  if (state.itemPick) return pickItemCell(r, c);
  // ...spectator/over/frozen/revealed/leading guards...
  if (state.revealConfirm) { /* first tap pending, second tap reveal */ }
  state.socket.emit('reveal', { row: r, col: c });
}
```

### Wrong: keep a highlight forever

```js
if (state.revealConfirm) state.revealPending = { row: r, col: c };
// never cleared on new game, item entry, or game over
```

### Correct: clear at every boundary

```js
function clearItemPick() {
  // ...
  state.revealPending = null;
}
function onRevealConfirmChange(checked) {
  state.revealPending = null;
  // ...
}
```
