# Hardening pass (November 2026)

After four QA rounds (`docs/qa/round-1.md` to `round-4.md`) fixed 60+ findings one by one, this pass rebuilt the
foundations those fixes depended on, so the same kinds of bug are caught or contained by design rather than case by case.

## 1. The tests are part of the product

Until now the regression checks lived in a temporary QA workspace and were run by hand. They are now in `tests/`, with
one runner (`node tests/run.cjs`), and **GitHub Actions runs them before every deploy**: a push to `main` that fails any
test doesn't reach the website (`.github/workflows/pages.yml`, job `test`, which `deploy` needs).

- 38 test files plus the database suite: browser flows in Chromium, sync merging, both Edge Functions, and every migration applied twice to fresh
  Postgres databases with the behaviour compared to a reviewed `tests/sql/expected.out`.
- Older checks that printed a summary for a person to read now have explicit expectations in `run.cjs`.
- Four checks that had drifted from the app were brought up to date and are now trusted again: the CSV formula guard
  (quoted output since round 3), low-data mode (bundled photos stay on purpose), the fleet page (has no photos), and the
  rescue check (raced the simulation).
- The CI job blocks the live Supabase project and all third-party hosts, so a demo-mode test can never write to the live
  demo world.

## 2. Forms are held to what they declare

Dialogs use `novalidate` (for friendlier messages), so nothing enforced the limits each field already declared, and every
handler re-checked by hand. Rounds 3 and 4 found handlers that missed one (prices, costs, model years). Now
`C.checkForm` (`js/ui.js`) checks every dialog form before its handler runs: `required`, `maxlength`, number `min` /
`max` / `step="1"`, `pattern`, and list options. The handlers' own checks stay as a second layer.

## 3. One failure can't freeze the app

Round 4 found bad data that crashed the simulation step and froze the shared demo for everyone (R4-02). Now:

- every click, change and input handler, every simulation step and the save run through `VF.safely` (`js/core.js`):
  a failing one is still reported (console, error monitoring, tests) but the others carry on;
- the person sees one short message ("Something went wrong…") instead of a page that silently stops working;
- a car-data permission that outlived its vehicle no longer crashes the Connect API simulation (found by the suite
  during this pass).

## 4. Open QA items closed

| Item | Now |
| --- | --- |
| OCPP network key left on a shared device (R4-01) | Removed at sign-out. The network's creator signs in and chooses **Recover a network you created**: the `ocpp` function issues a new key (`reissueKey`, creator only) and the old one stops working everywhere. |
| Map tiles reveal where a real car is (R3-14) | A map showing a real, connected car stops at zoom 13 (tiles about 5 km across), so the tile provider learns the area of town, not the street. Simulated vehicles keep full detail. |

## Still open (need a server-side redesign, not a patch)

- **R1-06 read-only role** and **R1-09 follower bandwidth**: every member's browser writes the whole workspace snapshot,
  so the server can't enforce a "view only" member or send only what changed. Both need per-record tables, or the
  simulation moved to the server.
- **R1-08 per-address limits**: the functions still get no trustworthy client address.
- **`p_expected` required** in the sync functions: from 1 December, once older cached apps have updated.
- **Hosting decisions**: your own tile and routing servers would remove the remaining location exposure entirely.
