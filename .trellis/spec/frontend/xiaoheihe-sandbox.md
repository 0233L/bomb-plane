# Xiaoheihe Mini Program Sandbox (`hb-sdk`) — Offline Edition

> Executable contract for running this game inside the Xiaoheihe App sandbox.
> Current deliverable (`xiaoheihe/`, version 0.2.0) is **offline**: local AI and
> same-device two-player, no network. Verified 2026-10-23 with
> `@heybox/hb-sdk@0.9.1`.
>
> The online WebSocket port is kept in the web version (`public/`, `server.js`,
> `ai.js`) and is **not** part of the mini program any more. Network/ICP notes
> are retained at the end as history so nobody re-applies without a filed domain.

## 1. Scope / Trigger

Apply this spec when frontend code is built for the Xiaoheihe 小程序工坊
(`xiaoheihe/`), especially when it touches:

- `LocalServer` (`src/legacy/local-server.js`) or its event contract
- same-device switching (`activeSeat` / `passReady` / `#switch-bar` / `.pass-modal`)
- suspend/resume (`suspendRoom` / `resumeRoom` / `#resume-card` / `state.resumeDraft`)
- probe confirmation (`revealConfirm` / `revealPending` / `bp_reveal_confirm`)
- `src/legacy/local-ai.js` (browser copy of `ai.js`)
- match history (`src/legacy/match-history.js`, `bp_match_history`, `#history-modal`)
- `package.json#heybox` permissions
- `localStorage` / `hbSDK.storage`, safe area, in-page dialogs
- `hb-sdk build` / `hb-sdk remote deploy`

The sandbox is a controlled WebView, **not** a WeChat mini program runtime.
Existing `miniprogram/` code does not apply. Do **not** edit `public/`,
`server.js`, `ai.js`, or `miniprogram/` when working on the offline package.
The web version's read-only history and probe confirmation are separate
contracts; see [web-match-history.md](./web-match-history.md) and
[web-reveal-confirm.md](./web-reveal-confirm.md).

## 2. Signatures

### `package.json#heybox` (offline)

```json
{
  "heybox": {
    "miniProgramId": "01a15288-dc63-73a6-90e7-f283d3b25abb",
    "name": "炸飞机",
    "desc": "单机炸飞机：人机对战、同屏双人（无需联网）",
    "category": "game",
    "platforms": ["android", "ios"],
    "permissions": { "storage": { "enabled": true } }
  },
  "version": "0.2.0"
}
```

`network` must be absent. A build that declares `network` reintroduces the
permission/ICP problem and implies a server that does not exist.

`version` must be valid SemVer and higher than every uploaded version.
`icon` is 200×200; `coverImages` are 1–5 images (510×272 recommended).

### `LocalServer` (drop-in replacement for `WSClient`)

```js
const socket = new window.LocalServer();
socket.connected;                 // always true
socket.on(event, cb);             // same as WSClient
socket.once(event, cb);
socket.off(event, cb);
socket.emit(event, data);         // client request → local handler
```

`client.js` must keep using this interface only. Do not call `LocalServer`
internals from UI code. `init()` constructs `new window.LocalServer()`; `ws.js`
must not be imported by `main.js`.

Load order in `main.js` is a contract:

```js
import './legacy/shared.js';        // window game primitives
import './legacy/local-ai.js';      // window.LocalAI (needs shared)
import './legacy/local-server.js';  // window.LocalServer (needs both)
import './legacy/match-history.js'; // window.MatchHistory (pure data; uses shared.js globals)
import './legacy/client.js';        // UI (needs LocalServer)
```

### Event contract (client → LocalServer)

| Event | Payload | Result |
|---|---|---|
| `createRoomAI` | `{name, avatar, mode, boardSize}` | `roomCreated` (seat 0, AI seat 1), AI auto-deploys |
| `createRoomLocal` | `{name, avatar, mode, boardSize}` | `roomCreated` (seat 0, seat 1 = 玩家2) |
| `deployConfirm` | `{planes:[{headRow,headCol,dir}]}` | `deployReady`; both ready → `battleStart` |
| `deployCancel` | `{}` | `deployReady` |
| `reveal` | `{row, col}` | `revealResult` (+ possible `gameOver`) |
| `useItem` | `{itemId, row?, col?, row2?, col2?}` | `itemResult` (+ possible `gameOver`) |
| `passReady` | `{seat}` | validates and switches seat → `reconnected` snapshot |
| `rematch` | `{}` | `rematchVote`; both agree → `rematchStart` |
| `setNickname` | `{name}` | `nicknameUpdated` |
| `setAvatar` | `{avatar}` | `avatarUpdated` |
| `suspendRoom` | `{}` | pause room; `roomSuspended` summary, or `leftRoom` when phase is `over` |
| `resumeRoom` | `{seat}` (local2p; 0 for AI) | validates seat → `suspended = false` + `reconnected` snapshot; failure → `resumeFailed` |
| `leaveRoom` | `{}` | `leftRoom` + room/timers cleared |
| `createRoom` / `joinRoom` | any | `error` (`离线版不支持联机房间`) |
| `rejoin` | any | `rejoinFailed` |
| `checkRooms` | any | `roomsAlive {alive: []}` |
| `visit` | any | `visitResult {total: 0}` |

### Event contract (LocalServer → client)

`roomCreated`, `deployReady`, `battleStart`, `revealResult`, `itemResult`,
`gameOver`, `rematchVote`, `rematchStart`, `nicknameUpdated`, `avatarUpdated`,
`roomSuspended`, `resumeFailed`, `leftRoom`, `reconnected`, `error`.

There is **no** `passDevice` event and no forced/automatic handoff in 0.2.0.
Switching happens only when the player taps `#btn-switch-now`.

`roomSuspended` carries only a summary (never planes/shots):
`{phase, mode, boardSize, names, avatars, steps, score, local2p, isAI,
activeSeat, deployConfirmed}`. `resumeFailed` carries
`{message, fatal}`; `fatal: true` means the suspended room is gone and the
resume card must be dismissed.

`reconnected` is reused as both the hot-seat snapshot and the resume snapshot.
Its final `local2p` field must be `!!room.local2p` — a hard-coded `true` makes
an AI resume render the hot-seat switch bar. Required fields:

```js
{
  roomId, seat, name, avatar, names, avatars, online: [true, true],
  phase, mode, boardSize, coins, steps, score, headsLeft, deployConfirmed,
  myPlanes, myShotsReceived, enemyShotsReceived,
  sonarHistory, frozenCells, winner, winReason, rematchVotes, isAI,
  planes,               // only when phase === 'over'
  local: true, local2p: true // local2p must reflect the room, not a constant
}
```

## 3. Contracts

### Offline/no-network contract

- Production `dist/index.html` and `dist/assets/*.js` must contain no
  `wss://`, `bomb-plane.onrender.com`, or `WebSocket` usage.
- There is no cold start, no connection banner, no reconnect, no spectator,
  no room number, no recent-room history, and no visitor counter.
- `emitIfConnected()` may remain as a guard, but `LocalServer.connected` is
  always true.

### Same-device two-player contract

- Server state: `activeSeat` = seat allowed to act; `clientSeat` = seat whose
  view the UI is showing. Actions are authorized by `activeSeat`, not by data
  sent from the client.
- **No forced handoff.** The rule `steps[seat] <= steps[other]` still decides
  whether an action is legal. The UI derives the prompt from that rule
  (`renderSwitchBar()` in `client.js`):
  - `mine < theirs` (behind): `#switch-bar` is hidden; keep acting to catch up.
  - `mine === theirs`: banner visible at opacity `.62`, text
    `可以切换给 <other> 行动`; the player may act or switch.
  - `mine > theirs` (leading): banner gets `.urgent` (opacity `1`, primary
    border), text `你已领先，请切换给 <other> 行动`; actions are rejected with
    `你的步数已领先，请切换玩家`.
- Deploy phase: after the current player confirms and the other has not, the
  banner is shown urgently (`你已部署完成，请切换给 <other>`). Confirming does
  not switch seats automatically.
- `dockSwitchBar()` prefers the active view's `#switch-slot` and falls back to
  inserting `#switch-bar` after `.topbar` (deploy view has no slot). The battle
  view wraps `#switch-slot` and `.battle-info-row` in `.battle-sticky-top`, and
  the CSS makes `.battle-sticky-top` the only sticky element
  (`top: calc(8px + var(--hb-safe-top))`, `z-index: 60`) with
  `.battle-sticky-top .switch-bar { position: static; }`. This guarantees the
  switch bar sits **above** the info row and scrolling cannot overlap them.
  Do not add `position: sticky` back to `.battle-info-row` or the bar itself.
  `.hidden` removes the bar from flow.
- Tapping `#btn-switch-now` opens the **opaque** full-screen `.pass-modal`
  (`background: var(--bg)`, `z-index: 110`) so the previous player's board
  cannot be seen. The other player taps `我是 X，开始` → `passReady {seat}`.
- `_handlePassReady(data)` re-validates server-side and ignores stale payloads:
  - `data.seat` must equal `1 - room.activeSeat`;
  - deploy phase: current seat must have `deployConfirmed`;
  - battle phase: `steps[next] <= steps[current]`; otherwise reject with
    `你的步数落后，先追平再切换`.
  On success it sets `activeSeat = clientSeat = next` and emits a fresh
  `reconnected` snapshot; the UI closes the pass modal only after applying it.
- After both deploy confirmations, the last confirmer holds the device and
  moves first (`activeSeat` unchanged by `battleStart`). Because players may
  voluntarily switch at equal steps, actions do not have to alternate 1:1.
- After a rematch, `resetToDeploy()` runs and `activeSeat = clientSeat`: the
  device holder deploys first, with no automatic pass.

### Suspend/resume contract

- 返回菜单 no longer calls `leaveRoom` in local mode. It stores an unconfirmed
  deploy draft in the in-memory `state.resumeDraft`
  (`{roomId, seat, planes}`) and emits `suspendRoom`.
- `_handleSuspendRoom()`:
  - no room → `leftRoom`;
  - `phase === 'over'` → `_clearRoom()` + `leftRoom` (history already saved);
  - otherwise sets `room.suspended = true`, clears `room.aiTimer` without
    firing it, and emits the summary. The summary must not include `planes` or
    shot records; the home card only needs phase/names/steps.
- While `room.suspended`, `_active()` returns null, `_handlePassReady()` and
  `_scheduleAITurn()` return early, and every reveal/item/deploy request is
  rejected. AI must not act on the home screen.
- `_handleResumeRoom({seat})`:
  - missing or not-suspended room → `resumeFailed {fatal: true}`;
  - `local2p`: `seat` must be 0/1 and equal `room.activeSeat`; otherwise
    `resumeFailed` **without** clearing the room/card (the correct player can
    still resume);
  - AI: seat 0;
  - success: `suspended = false`, `clientSeat = seat`, `_sendSnapshot(seat)`,
    then `_scheduleAITurn()` when phase is `battle`.
- `resumeDraft` is only applied when `roomId`/`seat` match, the seat has not
  confirmed deployment, and `state.draft` is still empty. It is cleared after
  the first `reconnected`. It never goes through `saveDraft()`/localStorage.
- `roomCreated` and `leftRoom` clear `state.suspended` and `state.resumeDraft`.
  A refresh loses both the room and the card (memory-only by design).

### Probe confirmation contract

- Storage keys are all in `HOST_STORAGE_KEYS`; `init()` restores them after
  host hydration:
  - `bp_reveal_confirm` — device-level choice, used by AI/online and by seat 0
    as a fallback;
  - `bp_reveal_confirm_p0` / `bp_reveal_confirm_p1` — per-seat choices in
    same-device two-player, so each player keeps their own toggle.
- `revealConfirmKey()` returns the p0/p1 key when `state.local2p`, otherwise
  the device key. `loadRevealConfirm()` falls back to the device key when the
  seat-specific key is unset/corrupt. `goBattle()` calls it after every seat
  switch/resume, so the checkbox reflects the player who is now acting.
- Toggling at seat 0 also writes the device key (owner preference); seat 1
  writes only `bp_reveal_confirm_p1` and never overwrites the owner's choice.
- State: `revealConfirm` (boolean) and `revealPending` (`{row, col}` or null).
- When off, `onEnemyCellClick()` emits `reveal` immediately (unchanged).
- When on, a first tap on an unknown cell sets `revealPending`, re-renders with
  `.cell-probe-target` (dashed outline), and toasts `再点一次这个格子确认探测`.
  Tapping a different cell retargets. Tapping the same cell clears pending and
  emits `reveal` once.
- Item selection is checked **before** this branch; item targeting/confirmation
  must not create or consume `revealPending`. Entering an item clears pending.
- `clearRevealPending()` also runs on `goBattle`/`goOver`, seat handoff, toggle
  changes, and resume, so a highlight cannot leak across players or games.
- The checkbox is hidden for spectators and after game over; the enemy-board
  note switches between the normal hint and `二次确认已开启…`.
- `renderBattleBoards()` must guard empty pick arrays
  (`if (pickKeys && pickKeys.length)`) before reading `pickKeys[0]`; otherwise
  selecting any 3×3 item throws `Cannot read properties of undefined` before
  `updateItemStatus()` runs.

### Information-hiding rules

- Planes/board live only in `LocalServer.room`; the UI receives per-cell
  reveal results and its own layout only.
- Snapshot arrays must be **copied element-by-element** (`map(s => ({...}))`).
  Passing the server arrays by reference lets `client.js` push into them on
  `revealResult`, double-counting heads and corrupting `headsLeft`.
- In local mode `goDeploy()` must set `state.draft = []` and `saveDraft()`
  must not persist `bp_draft`. Otherwise player 2 sees player 1's half-placed
  layout.
- `goBattle()` must not clear `state.sonarResults`; it is cleared in the
  `battleStart` handler (new game) so a seat handoff keeps sonar history.
- In `local2p`, seat 1 must not write `bp_name` / `bp_avatar`. Guard both the
  nickname modal and `setMyAvatar()`; the device owner's preferences are what
  the home screen restores after refresh.

### Match history contract

- One fixed storage key: `bp_match_history` (JSON array, newest first, max 20).
  It is whitelisted in `HOST_STORAGE_KEYS` so iOS restores it from
  `hbSDK.storage` after a reload. Do not generate per-game keys.
- Record shape:

  ```js
  {
    time: 1761234567890,        // 对局结束时间（毫秒时间戳）
    kind: 'ai' | 'local2p',
    mode: 'classic' | 'props',
    boardSize: 'S' | 'M' | 'L',
    names: [name0, name1],      // seat-indexed snapshots
    avatars: [avatar0, avatar1],
    steps: [steps0, steps1],
    winnerSeat: 0 | 1,          // no draws

    // Optional final-board snapshot; omitted for old/corrupt records.
    planes: [planesSeat0, planesSeat1], // [{ headRow, headCol, dir }]
    shots: [shotsSeat0, shotsSeat1]     // [{ row, col, result, destroyed? }]
  }
  ```

  Do not store `score` (per-room cumulative, not per-game), `roomId`, or
  `token`. Final-board snapshots are local-only and never sent to the server.
  `createRecord()` copies every array.
- `planes[seat]` is that seat's layout; `shots[seat]` contains shots fired
  **at** that seat. Build them at `gameOver` with
  `mySeat = state.seat === 1 ? 1 : 0`,
  `shots[mySeat] = state.myShotsReceived`,
  `shots[1 - mySeat] = state.enemyShotsReceived`, plus `d.planes`.
  Shot `result` is `empty | body | head | destroyed`; `destroyed: true` is the
  Doom Shroom marker and wins over other marks on the same cell.
- `match-history.js` exposes `window.MatchHistory` and touches neither DOM nor
  storage. `load(raw)` parses in try/catch, rejects non-arrays, drops records
  with invalid `time`/`winnerSeat`, caps names at 12 chars and avatars at 4,
  floors steps to non-negative integers, sorts newest first, caps at 20.
  It requires exactly two seat arrays with the spec's plane count for
  `planes`; invalid coordinates/out-of-bounds cells discard the whole snapshot
  while keeping the record. Invalid individual shots are skipped, at most 400
  per seat. Missing/invalid `shots` becomes `[[], []]`.
  `hasBoard(record)` reports whether a usable snapshot exists.
  `append(raw, record)` returns a new list with the record first. `serialize()`
  validates and truncates before `JSON.stringify`.
- Write exactly once per game from the client `gameOver` handler, after the
  existing assignments and `goOver()`:
  `if (!state.historyRecorded) { state.historyRecorded = true; recordMatchResult(d.winner, d.planes); }`.
  Reset `state.historyRecorded = false` in `battleStart`. Never write from
  `goOver()` (a restored finished room can call it again).
- `recordMatchResult` runs only when `state.localMode && !state.spectator`.
  For `local2p` it records both seats from `state.names/avatars/steps`
  regardless of `state.seat`; for `ai`, seat 0 is the human. It must not write
  `bp_name`/`bp_avatar` or call `setMyAvatar()`. All storage work is wrapped in
  try/catch so a failure never blocks the game-over screen.
- UI: home `#btn-history`; `#history-modal` (z-index 95) with `#history-list`,
  `#history-empty`, `#btn-history-x`, `#btn-history-close`,
  `#btn-history-clear`. `#confirm-modal` is z-index 96 so the clear
  confirmation sits above the history modal; `#history-detail-modal` is
  z-index 97 (toast stays at 100).
- Rows are built with `createElement` + `textContent`; nicknames must never be
  interpolated into `innerHTML`. Empty history hides the list, shows
  `#history-empty`, and disables `#btn-history-clear`. Clearing writes `'[]'`
  via `safeSet` (not `removeItem`), re-renders, and toasts.
- Rows with a snapshot get `.history-clickable`, `role="button"`,
  `tabIndex = 0`, Enter/Space handlers, and the hint `🛩️ 查看终局棋盘`.
  Old rows stay non-clickable with `旧记录未保存棋盘`.
- `openHistoryDetail(record)` renders result/meta plus two read-only boards
  from `buildBoard(record.planes[seat], record.boardSize)`; the winner's title
  gets `👑`. Never-probed cells get `.hist-dimmed`; destroyed cells get
  `.hist-x`. Boards are CSS Grids (`--n` columns, `aspect-ratio: 1`) so 14×14
  fits without horizontal overflow. Closing the detail returns to the still
  open list; opening/closing the list closes the detail first.
- Detail board CSS must stay above the list but below toast; never use a
  `<table>` for the board (14×14 overflows narrow screens).
- `showView()` closes the history modal so switching pages cannot leave it on
  top of another view.

### Runtime gate

The dev server injects `data-heybox-runtime-gate` into `index.html`. App
scripts are held until the debug host completes the nonce handshake. In
Puppeteer, open the debug page
`http://127.0.0.1:5176/?mini_url=...` and run assertions inside the
`127.0.0.1:5175` iframe; opening 5175 directly leaves globals undefined.
Do not judge the app broken before the iframe exposes
`typeof window.LocalServer === 'function'` and `#home-avatar` has text.

### Host capabilities kept from the online port

- `localStorage` is optional; wrap reads/writes and keep an in-memory fallback.
  On iOS it may not survive reload; mirror keys to `hbSDK.storage`
  (`permissions.storage.enabled = true`, no approval needed). Hydrate before
  `init()` with a capped wait (1 s).
- `window.confirm` / `window.prompt` are suppressed on iOS. Use the in-page
  confirm/nickname modals.
- Include `viewport-fit=cover`; call `hbSDK.viewport.getWindowInfo()` and write
  `--hb-safe-*` variables. CSS uses
  `var(--hb-safe-top, env(safe-area-inset-top, 0px))`. Apply insets to the pass
  modal too.
- Nickname filtering (NFKC, zero-width strip, 12-char cap, URL/ad/profanity
  rejection) stays in the client. Empty input falls back to a random name.
- Clipboard/sharing are not used by the offline UI; room-tag and copy buttons
  are hidden with `.hidden` by `updateRoomChrome()`.

## 4. Validation & Error Matrix

| Condition | Symptom | Handling |
|---|---|---|
| `main.js` imports `ws.js` | Production bundle contains `wss://...`; permission/ICP problem returns | Never import `ws.js`; construct `LocalServer` |
| `network` left in `package.json` | Platform asks for network permission with no server | Remove it; only `storage` |
| Action while leading (`steps[seat] > steps[other]`) | Leading side keeps playing while the other waits | Reject; `.urgent` banner prompts switching |
| `passReady` while the next seat would lead | Other player takes over but cannot act | Reject with `你的步数落后，先追平再切换`; banner stays hidden while behind |
| Snapshot passes server arrays by reference | Heads counted twice; wrong win/loss | Clone every array/object in `_sendSnapshot` |
| Local draft restored after switching | Player 2 sees player 1's planes | `state.draft = []` in local mode; skip `bp_draft` save |
| `goBattle()` clears sonar history | Sonar numbers vanish on every switch | Clear in `battleStart` only |
| Seat 1 saves nickname/avatar | Device owner's name/avatar overwritten after refresh | Guard `state.local2p && state.seat !== 0` |
| Pass modal translucent | Previous player's layout visible | Opaque `background: var(--bg)`, `z-index: 110` |
| Random nickname longer than 12 chars (`MightyPenguin`) | Input value fails nickname validation on deploy | `randomName()` falls back to the noun; hydration clears invalid stored `bp_name` |
| Removed home elements queried | `TypeError` on missing `#recent-card` / `#btn-invite-*` | Guard optional elements (`if (el)`) |
| Refresh during a local game | Old room cannot be resumed | Always return home; suspended rooms are memory-only |
| AI timer fires after leaving | AI acts in a dead room | `_clearRoom()` clears `aiTimer` / `aiRematchTimer` |
| AI keeps playing on the home screen | Steps rise while suspended | `_handleSuspendRoom` clears `aiTimer`; `_scheduleAITurn` guards `room.suspended` |
| Suspended room still accepts reveals | Ghost actions from a stale board | `_active()` returns null while suspended |
| Resume reports `local2p: true` for AI | Hot-seat switch bar appears after resume | `_sendSnapshot` sends `!!room.local2p` |
| Wrong seat resumes a local2p room | Opponent sees the active player's layout | `_handleResumeRoom` rejects mismatched seat non-fatally; card stays |
| Suspended deploy draft persisted | Player 2 finds Player 1's draft after refresh | Keep it only in `state.resumeDraft`; never `saveDraft()` |
| Resume card left after finishing | Dead room looks resumable | `phase === 'over'` suspend clears the room and emits `leftRoom` |
| Switch bar overlaps the info row | Player stats hidden while scrolling | Single sticky `.battle-sticky-top`; bar `position: static` inside it |
| First item tap throws before the hint bar | No selection guidance / active state | Guard `pickKeys.length` in `renderBattleBoards()` |
| Reveal pending survives a seat switch | Next player sees a stale dashed target | Clear pending on handoff/resume and item entry |
| One toggle overwrites the other player's choice | Guest turns confirmation off for the owner (or vice versa) | Per-seat keys `bp_reveal_confirm_p0` / `p1`; seat 1 never writes the device key |
| Seat-specific key missing after upgrade | Checkbox resets although the owner had enabled it | Fall back to `bp_reveal_confirm` when the p0/p1 value is unset/invalid |
| AI during human disconnect | N/A offline (human always connected) | No pause logic needed |
| `local-ai.js` uses `process.env` | `ReferenceError` in browser | Fixed defaults at the top of the copy |
| `ai.js` requires Node modules | Bundler error | Browser copy replaces `require` with `window` globals |
| `bp_match_history` contains bad JSON / `{}` / null entries | History modal or home crashes | `load()` returns `[]`, invalid records are dropped; all storage access is in try/catch |
| History write happens twice for one game | Duplicate records | `state.historyRecorded` guard in `gameOver` + server phase check |
| Clear confirmation hidden behind history modal | Cannot confirm clearing | `#confirm-modal { z-index: 96 }` above `.modal` (95) |
| `local2p` record logs only the current seat | Opponent name/steps missing | Read `state.names/avatars/steps` seat-indexed regardless of `state.seat` |
| Shots stored under fixed seats | Two boards show each other's marks after a seat switch | Map by `state.seat` (`mySeat`); `local2p` records both seats |
| Old record has no `planes` | Clicking it would render blank boards | `hasBoard()` check; show `旧记录未保存棋盘`, no click handler |
| Corrupt `planes` accepted | Crashes or out-of-bounds cells when drawing | Validate seat count, plane count, dir, and every cell via `getPlaneCells`; drop whole snapshot only |
| Corrupt individual shot | One bad `result` breaks the whole board | Skip that shot; keep valid shots |
| Detail modal under history modal | Clicked row seems to do nothing | `#history-detail-modal { z-index: 97 }` |
| Board rendered as `<table>` | 14×14 overflows 390 px screens | CSS Grid with `--n`, `aspect-ratio: 1`, scrollable board region |
| Nickname contains HTML | Markup injected into history list | Build rows with `textContent`, never `innerHTML` |

Historical network rows (do not re-apply without a filed domain):

| Condition | Symptom | Handling |
|---|---|---|
| Domain has no ICP filing | `network` auto-rejected (`系统 ICP 核验`) | Use an ICP-filed mainland domain |
| `network` not approved, production | CSP `connect-src 'none'` | Do not release an online build |
| `location.host` used for WS | Connects to Xiaoheihe host | Hard-code an absolute URL |

## 5. Good / Base / Bad Cases

- **Good**: home → 人机对战 → random deploy → confirm → battle; AI replies
  after 0.8–1.5 s; game over → 再来一局 → AI auto-votes and a fresh deploy
  starts. Home → 同屏双人 → P0 deploy → urgent banner → P0 taps 切换玩家 →
  opaque pass page → P1 deploy (empty draft) → battle; the behind player keeps
  acting, an equal score shows the translucent switch prompt, leading shows the
  opaque/urgent prompt; switching happens only after tapping the banner button.
- **Base**: user opens the app with no storage; home renders with a random
  avatar and random nickname fallback (always ≤ 12 chars); rules/theme work;
  both modes start.
- **Bad**: reusing the online client unchanged (shows an endless "connecting"
  banner, online buttons, stale room history), covering the top bar with the
  switch banner, or showing the pass page translucently (leaks the previous
  player's planes).

## 6. Tests Required

1. `npm run build` passes and `dist/assets/*.js` / `dist/index.html` contain
   no `onrender`, `wss://`, or `WebSocket`.
2. `dist/manifest.json` permissions contain only `storage`.
3. Browser Mock (`hb-sdk dev`, debug page + iframe):
   - home has only 人机对战 / 同屏双人; no create/join/recent/visitor/banner;
   - AI classic S: deploy → battle → fire; AI replies; full game ends; rematch
     returns to deploy;
   - hot-seat: P0 deploy → banner urgent but no automatic modal → tap 切换玩家
     → pass page (opaque, full viewport, correct name) → P1 deploy (empty
     draft) → battle. Assert: behind hides banner and allows actions; equal
     shows non-urgent banner (`opacity .62`) and allows actions; leading shows
     `.urgent` (`opacity 1`) and rejects actions with a prompt to switch; after
     each switch assert perspective, names, steps, own shots, enemy shots, and
     sonar; the banner sits below the active `.topbar`;
   - rematch: no forced pass; the current device holder deploys first; steps
     reset to 0:0;
   - props: sonar by P1 → voluntary switch → number appears on P0's own board;
     both step counts and coin deductions correct; full props AI game ends
     without errors;
   - classic/props × S/M/L: board cell counts (100/144/196), head counts
     (3/4/6), item panel visibility;
   - nickname/avatar: P1 changes them; P0 sees them after switching; refresh
     restores P0's stored name/avatar, not P1's; 20k `randomName()` samples are
     all ≤ 12 chars; an overlong stored `bp_name` is neither prefilled nor kept;
   - match history: empty state shows `#history-empty` and disables clear;
     ✕ / 关闭 / backdrop all close; one finished AI game writes exactly one
     `bp_match_history` record with correct name/steps/winnerSeat; rematch adds
     one more; a local2p record contains both seats' names/avatars/steps; the
     clear confirmation sits above the history modal; clearing writes `[]` and
     disables the button; inject bad JSON / `{}` / null entries and confirm home
     still loads; 25 appends keep only the newest 20; refresh keeps records;
   - finished AI/local2p records save `planes` + `shots`; tapping a clickable
     row opens `#history-detail-modal` above the list; two boards match the
     spec (S/M/L → 100/144/196 cells, 3/4/6 heads per board); destroyed cells
     show `hist-x`; unshot cells show `hist-dimmed`; return button closes only
     the detail. Old records without `planes` show `旧记录未保存棋盘` and do not
     open anything;
   - 390×844 with 20 records: modal stays in viewport, list scrolls, long
     names/emoji wrap without breaking the layout;
   - 390×844 with a 14×14 detail: box and return button stay in the viewport,
     boards remain square and do not overflow horizontally, board region
     scrolls;
   - suspend/resume: return menu during deploy and battle shows `#resume-card`
     with the correct summary; waiting 3 s on home does not change AI steps;
     resume restores steps/board/draft and AI continues; local2p resume shows
     the opaque pass modal first and only the active seat can resume; a wrong
     seat keeps the card; finished games and refresh show no card;
   - layout: with the switch bar visible, `#switch-bar` bottom ≤
     `.battle-info-row` top at scroll 0 and after scrolling; neither is clipped;
   - reveal confirmation: default off; first tap only highlights, retargets on
     another cell, second tap on the same cell reveals once; item flow unchanged;
     the toggle survives a reload (host storage);
   - per-seat preference: P0 on + P1 off (and vice versa); after each handoff the
     checkbox and behavior follow the new active seat; switching back restores
     the previous player's choice; P1 does not change P0's/device key;
   - rules modal, theme cycle, return-menu confirm, refresh returns home.
4. `window.MatchHistory` pure checks: `normalizeRecord` drops bad values,
   `load` / `append` cap at 20 and order newest-first, formatters return the
   expected labels; invalid `planes` drop the snapshot but keep the record;
   invalid shots are skipped and `destroyed` only accepts boolean `true`.
5. Real device (iOS at minimum):
   - AI game and hot-seat game;
   - pass page covers the notch/safe area and is opaque;
   - history modal and clear confirmation usable around the notch/safe area;
   - history row → 14×14 detail → return, boards square and scrollable;
   - return menu and refresh behavior.
6. For offline-only changes, `git status` shows no changes under `public/`,
   `server.js`, `ai.js`, `miniprogram/`. The later web-history follow-up
   intentionally changes `public/` (see web-match-history.md) but still leaves
   `server.js`, `ai.js`, and `miniprogram/` untouched.

## 7. Wrong vs Correct

### Wrong: keep the online client and hope the sandbox has network

```js
import './legacy/ws.js';
state.socket = new WSClient(); // fails or is CSP-blocked; home shows "连接中" forever
```

### Correct: local server with the same interface

```js
state.socket = new window.LocalServer(); // connected = true, no network
```

### Wrong: hand the server arrays to the UI

```js
myShotsReceived: player.shotsReceived, // client pushes into the same array
```

### Correct: copy every snapshot entry

```js
myShotsReceived: player.shotsReceived.map(function (s) {
  return { row: s.row, col: s.col, result: s.result, destroyed: s.destroyed };
}),
```

### Wrong: restore a local deployment draft after handoff

```js
const draft = JSON.parse(safeGet('bp_draft') || '[]');
state.draft = draft; // player 2 sees player 1's planes
```

### Correct: local mode always starts empty

```js
if (state.localMode) state.draft = [];
```

### Wrong: let seat 1 overwrite device preferences

```js
safeSet('bp_name', checked.name); // player 2's name survives refresh
```

### Correct: only seat 0 persists

```js
if (!(state.local2p && state.seat !== 0)) safeSet('bp_name', checked.name);
```

### Historical: online endpoint (not used by 0.2.0)

```js
const WS_URL = 'wss://bomb-plane.onrender.com/ws'; // ICP filing rejected
```
