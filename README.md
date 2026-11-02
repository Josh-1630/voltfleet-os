# VoltFleet OS — MVP

One platform that connects **EV drivers**, **their vehicles** (any make) and **charging stations**, plus **VoltFleet Connect**, an API that other companies build on. It has four role-based apps:

| App | Who | What it does |
| --- | --- | --- |
| **Driver app** (mobile-first) | EV drivers | Live battery %, range, and driving time left on this charge. Trip progress with battery % on arrival. A warning when the driver won't make it. Chargers on the route, filtered to plugs that fit the car. **One tap to book**: checks live availability of every compatible connector along the route and holds a slot for the arrival time, so there's no queue. Live charging view, bookings, vehicle data, and privacy controls. |
| **Operator console** (CSMS) | Charge point operators | Live view of every station and connector (OCPP states), with power, energy and time per session. Remote commands (stop, unlock, reset, enable/disable). Arriving bookings and a connector timeline. Booking rules, time-of-use prices, and smart charging under each site's grid limit (booked sessions keep full power). Reports and the OCPP message log. |
| **VoltFleet Connect** (developer portal) | Fintechs, insurers, ride-hailing, energy companies | One API for any EV make (battery, charging, start/stop charge, odometer, tyres, location, lock). Apps & keys (client ID/secret, rotate), test vehicles, an API explorer with real error codes, a VIN compatibility check, webhooks (`charge.started`, `charge.completed`, `battery.low`, `vehicle.connected/disconnected`) with signed deliveries, docs and per-vehicle pricing. Drivers grant access through the **Connect consent flow** (pick brand → sign in with the carmaker or pair a plug-in device → approve each permission) and can revoke it in the driver app. |
| **Super admin console** | VoltFleet staff | Network-wide KPIs and map, operators, stations and bookings. Vehicle make integrations (BYD, Tesla, Rivian, Hyundai, Kia, Nissan, VW, Ford, MG, plus a universal OBD-II dongle) with data coverage and a plug compatibility matrix. Users with masked personal data. A privacy and compliance center. The demo clock. |

## Privacy by design

- **Role-based access.** Each role reaches only its own app. Opening another role's page is refused and logged.
- **Data minimisation.** Stations see a booking code, the vehicle model and, only if the driver agrees, a live arrival time and battery %. They never see a name, phone, plate or location.
- **Unlinkable pseudonyms.** Each operator sees a different ID for the same driver, and each developer app gets its own vehicle ID, so networks and apps can't link a driver's activity.
- **Scoped API access.** Apps only get the permissions the driver approved. Location is always optional, and webhook payloads include a station only when location was granted. Revoking access cuts the app off at once and tells it to delete the data within 30 days.
- **Masked by default.** Admins see masked names, phones and plates. Revealing them needs a stated reason and is written to the audit log.
- **Location stays on the phone.** No GPS traces are stored. The admin map shows only zone counts of k ≥ 3 drivers.
- **Driver rights.** Drivers can change each consent in the app, download a copy of their data, and delete their account. Deletion erases personal data and keeps only pseudonymous billing records for the retention period.
- **Before launch**, map the platform to: Ghana Data Protection Act 2012 (Act 843) and Data Protection Commission registration, plus GDPR, Kenya DPA 2019 and Nigeria NDPA 2023 for expansion. Have a lawyer review the consent texts and retention periods.

## What's real and what's simulated

All data is simulated so the product can be demonstrated end to end: 10 stations, 2 operators, 29 drivers, 14 vehicle models, and a demo clock running at 20× speed (adjustable under Admin → System). Everything is stored in the browser. The vehicle make data coverage shown is *expected* and must be confirmed for each integration.

## Shared demo state (Supabase)

Every device that opens the demo shares one live world, stored in Supabase (project `voltfleet-os`, London, eu-west-2). A booking made on a phone shows up on an operator's laptop within about a second.

- **One device leads.** A visible device runs the simulation and saves a compressed snapshot (about 20 KB) every 2 seconds through `world_tick`. A 6-second lease stops two devices from running it at once; if the leader closes, another device takes over.
- **User actions land straight away.** Bookings, cancellations, consent changes and similar actions are saved through `world_push`, and the leader adopts them.
- **Everyone stays current.** Each device subscribes to Supabase Realtime and also checks the revision every 5 seconds as a safety net.
- **Per-device sign-in.** Who is signed in stays with each browser tab.
- **Offline fallback.** If Supabase can't be reached (or `js/config.js` has no `url`), the app runs on that device alone, and tabs in the same browser still sync with each other.
- **Security.** Row Level Security lets the public key read the demo world but not change it directly; the two write functions accept only the single `demo` world and cap its size. Because the demo has no real logins, anyone with the link can change the shared world. **Admin → System → Reset demo data** restores it for everyone.

**For production,** replace the single shared world with real tables (stations, connectors, bookings, sessions, drivers) and Supabase Auth, with Row Level Security per role and operator. The privacy rules the UI enforces today would then be enforced by the database.

## Run locally

```
python3 -m http.server 8080   # then open http://localhost:8080
```

## Deploy

No build step. Upload this folder to any static host:

- **Netlify:** drag the folder onto https://app.netlify.com/drop (`netlify.toml` is included)
- **Vercel:** `npx vercel`, framework "Other"
- **Cloudflare Pages / GitHub Pages:** deploy the folder root

## Files

- `index.html`, `styles.css`
- `js/core.js`: data model, demo clock and live feed, vehicle catalog, booking engine, load balancing, privacy layer, map and charts
- `js/driver.js`, `js/operator.js`, `js/admin.js`: the three apps
- `js/connect.js`: VoltFleet Connect (developer portal, consent flow, simulated API and webhooks)
- `js/cloud.js`, `js/config.js`: cross-device sync through Supabase (`js/vendor/` holds the MIT-licensed supabase-js client)
- `js/app.js`: sign-in, role-based routing, live updates
- `sw.js`, `manifest.webmanifest`: offline use and install to home screen

## Next steps to production

1. **Backend and auth.** Move from the shared demo world to real Supabase tables with row-level security per role and operator. Phone/email OTP for drivers; SSO + MFA for staff.
2. **OCPP 1.6J / 2.0.1 central system.** `ReserveNow`, `RemoteStart/Stop`, `SetChargingProfile` and `StatusNotification` drive the booking and load-balancing features shown here.
3. **VoltFleet Connect for real.** An OAuth 2.0 authorization server, a public REST API with rate limits, signed webhooks, and usage-based billing.
4. **Vehicle data adapters.** Tesla Fleet API and a BYD partner/OBD-II path first, then an aggregator for Rivian and other makes. Each adapter outputs the unified vehicle record shown in Admin → Vehicles & OEMs.
5. **Payments and messaging.** Mobile money and card payments for booking and no-show fees; SMS/push notifications.
6. **Maps.** A real routing engine and live traffic, replacing the schematic Greater Accra network.
