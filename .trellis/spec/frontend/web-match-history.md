# Web Match History — Read-Only Contract

> Contract for the web version (`public/`). The offline Xiaoheihe package has its
> own writable history contract in
> [xiaoheihe-sandbox.md](./xiaoheihe-sandbox.md); do not copy the clear action or
> hot-seat `local2p` entry into the web version.

## 1. Scope / Trigger

Apply this spec when changing:

- `public/match-history.js` (`window.MatchHistory`)
- the `bp_match_history` localStorage value
- `public/client.js` history recording, `state.isAI`, `state.historyRecorded`
- `#btn-history` / `#history-modal` in `public/index.html` or its CSS

The web version records **AI and online matches** automatically and shows a
read-only list. It has no clear button and no same-device two-player mode.
`server.js` is not involved: the record is built from the existing `gameOver`
payload and client state.

## 2. Signatures

```js
window.MatchHistory = {
  STORAGE_KEY,            // 'bp_match_history'
  MAX_RECORDS,            // 20
  createRecord(input),    // -> normalized record
  normalizeRecord(value), // -> normalized record | null
  hasBoard(record),       // -> boolean (has a valid final-board snapshot)
  load(raw),              // JSON string -> record[] (newest first)
  append(raw, record),    // -> record[] (NOT a JSON string)
  serialize(list),        // record[] -> JSON string
  formatTime(ts),
  formatKind(kind),       // ai / online / local2p (compat)
  formatMode(mode),
  formatBoardSize(size),
  formatResult(record),
  formatSteps(record),
  formatMeta(record)
};
```

Client helpers:

```js
loadMatchHistory()          // safe wrapper around MatchHistory.load
saveMatchHistory(list)      // safeSet(key, MatchHistory.serialize(list))
recordMatchResult(winner)   // one record per finished game
renderMatchHistory()        // rebuild #history-list with createElement/textContent
openHistoryModal() / closeHistoryModal()
openHistoryDetail(record)   // read-only final boards for one record
closeHistoryDetail()
```

`gameOver` sets `state.historyRecorded = true` before calling
`recordMatchResult`; `battleStart` resets it to `false`. `showView()` closes the
history modal.

## 3. Contracts

### Stored record

```js
{
  time: 1761234567890,
  kind: 'ai' | 'online',       // web actual values
  mode: 'classic' | 'props',
  boardSize: 'S' | 'M' | 'L',
  names: [name0, name1],       // copies, max 12 code points each
  avatars: [avatar0, avatar1], // copies, max 4 code points each
  steps: [steps0, steps1],     // non-negative integers
  winnerSeat: 0 | 1,

  // Optional final-board snapshot. Present only when the stored planes pass
  // validation; old records and corrupt snapshots omit both fields.
  planes: [planesSeat0, planesSeat1], // [{ headRow, headCol, dir }] x planeCount
  shots: [shotsSeat0, shotsSeat1]     // [{ row, col, result, destroyed? }]
}
```

- One fixed key, JSON array, newest first, maximum 20 records.
- Do not store `score`, `roomId`, token, or credentials.
- The final-board snapshot is local-only and never sent to the server. It is
  captured at `gameOver` from the existing `d.planes` payload and the client's
  received-shot arrays; the UI must not fetch or reconstruct it from the server.
- `planes[seat]` is the layout owned by that seat. `shots[seat]` is every shot
  fired **at** that seat. At game over map the client arrays by its own seat:
  `shots[mySeat] = state.myShotsReceived`, `shots[1 - mySeat] =
  state.enemyShotsReceived`, with `mySeat = state.seat === 1 ? 1 : 0`.
- `result` is one of `empty | body | head | destroyed`; `destroyed: true` marks
  a cell eaten by the Doom Shroom. When multiple shots touch one cell, the
  destroyed marker wins during rendering.
- `recordMatchResult` must not write `bp_name` or `bp_avatar`.
- Spectators (`state.spectator`) and clients without a seat are never recorded.
- `state.isAI` comes from `roomCreated.isAI` / `reconnected.isAI`; `joinedRoom`,
  `leftRoom`, and `spectatorJoined` make it false.
- The web UI is read-only: `#btn-history-clear` must not exist.
- History rows with `hasBoard(record)` get `.history-clickable`, `role="button"`,
  `tabIndex = 0`, and Enter/Space handlers. Rows without a snapshot stay
  non-clickable and show `旧记录未保存棋盘`; clickable rows show
  `🛩️ 查看终局棋盘`.
- `#history-detail-modal` sits above `#history-modal` (`z-index: 97` vs `95`,
  below toast `100`). Closing it returns to the still-open list. Opening or
  closing the list closes the detail first.
- The detail view is a final snapshot, not a move-by-move replay. Boards are
  read-only CSS Grids sized by `--n`; cells use `hist-head` / `hist-body` /
  `hist-empty`, `hist-dimmed` for never-probed cells, and `hist-x` for destroyed
  cells.

## 4. Validation & Error Matrix

| Input / condition | Result |
|---|---|
| missing key, bad JSON, `{}`, `null`, non-array | `load()` returns `[]` |
| record is not an object, invalid `time`, `winnerSeat` not 0/1 | record is dropped |
| unknown `kind` | falls back to `online`; `local2p` is accepted for compatibility |
| unknown `mode` / `boardSize` | falls back to `classic` / `S` |
| missing/oversized names or avatars | safe default + code-point truncation |
| `planes` missing / not two seats / wrong plane count / bad dir / out-of-bounds | whole snapshot omitted; record still listed as `旧记录未保存棋盘` |
| `shots` missing / not two arrays | snapshot kept with empty shot arrays (everything dimmed) |
| an individual shot has a bad `result`, non-integer or out-of-bounds row/col | that shot is skipped; other shots kept |
| more than 400 shots for one seat | extra shots dropped |
| more than 20 records | newest 20 kept |
| spectator finishes game | no record |
| reconnect reports `phase: 'over'` | no new record (avoids duplicates) |
| localStorage read/write throws | game continues; history silently unavailable |
| nickname contains HTML | rendered as text, never injected as markup |

## 5. Good / Base / Bad Cases

- Good: an AI game ends once → one `kind: 'ai'` record; rematch starts →
  `battleStart` resets the guard → one new record.
- Base: both online players finish → each browser stores one `kind: 'online'`
  record with the same names, steps, and `winnerSeat`.
- Good: two online browsers store identical `planes` and `shots` even though
  their seat views are opposite; this is the acceptance check for seat mapping.
- Good: opening a record renders two boards; 14×14 stays square on mobile and
  the boards region scrolls while the header and return button stay visible.
- Bad: calling `append()` and writing its return value directly to
  `localStorage` stores `[object Object]`; call `serialize()` first.
- Bad: recording inside `goOver()` duplicates records because `reconnected`
  calls `goOver()` for an already-finished room.
- Bad: storing `state.myShotsReceived` directly into `shots[0]`; the current
  client may be seat 1, so both shot arrays end up swapped.

## 6. Tests Required

- `node test/match-history-ui-test.js` — 62 jsdom assertions:
  AI/online records, rematch, duplicate `gameOver`, spectator and reconnect
  suppression, no `bp_name`/`bp_avatar` writes, read-only modal, HTML safety,
  bad JSON, 20-record cap and newest-first ordering, clickable rows, old-record
  fallback, two-board detail rendering, and malformed `planes`/`shots`.
- Regression tests: `home-ui-test` (95), `avatar-ui-test` (37),
  `double-tap-confirm-test` (25), `item-render-test` (31), `sonar-render-test`
  (17) must remain green.
- Real browser (local server, non-production port): AI game + reload, two-page
  online game, both histories, identical `planes`/`shots` across seats, detail
  modal for both AI and online records, mobile 390×844 modal bounds, no console
  errors.
- Layout acceptance: seed 20 records and open a 14×14 detail at 390×844 and
  1280×900; both boards stay square, do not overflow horizontally, and the
  close button remains in the viewport.
- Existing `server.js` protocol tests must need no changes.

## 7. Wrong vs Correct

### Wrong: treat `append()` as a serialized value

```js
localStorage.setItem(KEY, M.append(raw, record)); // stores [object Object]
```

### Correct: serialize the returned list

```js
localStorage.setItem(KEY, M.serialize(M.append(raw, record)));
```

### Wrong: record from `goOver()`

```js
function goOver() {
  state.over = true;
  recordMatchResult(state.winner); // also runs on reconnect
}
```

### Correct: guard the `gameOver` event only

```js
s.on('gameOver', function (d) {
  /* ... goOver() ... */
  if (!state.historyRecorded) {
    state.historyRecorded = true;
    recordMatchResult(d.winner, d.planes);
  }
});
```

### Wrong: assume the client is seat 0 when storing shots

```js
shots[0] = state.myShotsReceived;
shots[1] = state.enemyShotsReceived;
```

### Correct: map by the current seat

```js
const mySeat = state.seat === 1 ? 1 : 0;
shots[mySeat] = state.myShotsReceived.map(/* copy fields */);
shots[1 - mySeat] = state.enemyShotsReceived.map(/* copy fields */);
```

### Wrong: build rows with `innerHTML` and nicknames

```js
li.innerHTML = '<span>' + record.names[0] + '</span>';
```

### Correct: `textContent`

```js
player.textContent = avatar + ' ' + name;
```
