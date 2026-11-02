# VoltFleet OS — EV Manager

One platform that connects **EV fleets**, **drivers**, **their vehicles** (any make) and **charging stations**, plus **VoltFleet Connect**, an API that other companies build on. It has five role-based apps that share one design system (Electric Teal & Fresh White, light by default with a dark mode):

| App | Who | What it does |
| --- | --- | --- |
| **EV Manager** (default sign-in) | Fleet managers | **Dashboard** with 8 live KPIs (vehicles, active, average battery, energy, charging cost, range, CO₂ saved, available stations), vehicle overview, live map, charging activity, energy/cost/CO₂ charts, utilisation and battery health, quick actions. **My Vehicles** (grid/table, search and filters, detail with battery health, performance, maintenance history and registration, add/remove vehicles). **Charging Stations** (list/map, connector, speed and availability filters, live tariffs, distance, directions, send a vehicle). **Charging Sessions** (live and completed, energy, duration, cost, stop charging, CSV). **Trips & Routes** (journey planner with route map, energy estimate, charging-stop suggestion and dispatch; live journeys; history). **Fleet Management** (depots, vehicle allocation, drivers, utilisation, performance). **Energy Analytics** (consumption vs charged, charging by hour and tariff band, cost, efficiency per vehicle, battery health, sustainability). **Reports** (fleet performance, energy, charging expenditure, sustainability, maintenance; preview and CSV). **Notifications** (filters, read/delete, alert preferences). **Settings** (profile, theme, organisation and depots, integrations, data export and reset). |
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

All data is simulated so the product can be demonstrated end to end: 10 stations, 2 operators, 29 drivers, 14 vehicle models, a 16-vehicle company fleet (GreenLine Logistics, 14 employee drivers, 2 depots), and a demo clock running at 20× speed (adjustable under Admin → System). The vehicle make data coverage shown is *expected* and must be confirmed for each integration.

Sample data is kept apart from the product code: `js/fleet.js` holds the fleet seed, simulation and the 30-day sample history (marked `SAMPLE DATA`); the pages in `js/manager.js` and `js/manager-more.js` only read it through `VF.fleet*` functions, so a real telematics/OCPP backend can replace that one file. Fleet vehicles charge at the same simulated public stations, so their sessions appear in operators' consoles as "Fleet · GreenLine Logistics" (never a driver name).

### Integrations that need configuration

- **Street maps:** maps are a schematic of Greater Accra. To use a map provider, set `window.VOLTFLEET_MAPS = { provider, key }` in `js/config.js` with a browser key restricted to your domain, and render it where `VF.mapSVG` is called (`VF.mgr.fleetMap` for the EV Manager).
- **Vehicle telematics:** connect vehicles through VoltFleet Connect (carmaker login or OBD-II device); replace the simulation in `js/fleet.js`.
- **Email notifications:** needs a server-side email provider. Keep its API key on the server, never in this web app.
- **CO₂ factors:** `VF.CO2` in `js/fleet.js` uses approximate diesel and Ghana grid factors; replace them with audited figures before publishing.

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

- `index.html`, `styles.css` (design tokens, shell, components, responsive rules; light and dark themes)
- `js/core.js`: data model, demo clock and live feed, vehicle catalog, booking engine, load balancing, privacy layer, map and charts
- `js/icons.js`: a subset of [Lucide](https://lucide.dev) icons (ISC licence, `js/vendor/lucide.LICENSE`)
- `js/ui.js`: reusable components (metric cards, status badges, tables, charts, battery bars, dialogs, form fields) and the theme switch
- `js/fleet.js`: EV Manager data layer and simulation (sample data)
- `js/manager.js`, `js/manager-more.js`: the EV Manager pages
- `js/driver.js`, `js/operator.js`, `js/admin.js`: the driver, operator and admin apps
- `js/connect.js`: VoltFleet Connect (developer portal, consent flow, simulated API and webhooks)
- `js/cloud.js`, `js/config.js`: cross-device sync through Supabase (`js/vendor/` holds the MIT-licensed supabase-js client)
- `js/app.js`: sign-in, the shell (collapsible sidebar, breadcrumb, global search, notifications, account menu), role-based routing, live updates
- `sw.js`, `manifest.webmanifest`: offline use and install to home screen

## Next steps to production

1. **Backend and auth.** Move from the shared demo world to real Supabase tables with row-level security per role and operator. Phone/email OTP for drivers; SSO + MFA for staff.
2. **OCPP 1.6J / 2.0.1 central system.** `ReserveNow`, `RemoteStart/Stop`, `SetChargingProfile` and `StatusNotification` drive the booking and load-balancing features shown here.
3. **VoltFleet Connect for real.** An OAuth 2.0 authorization server, a public REST API with rate limits, signed webhooks, and usage-based billing.
4. **Vehicle data adapters.** Tesla Fleet API and a BYD partner/OBD-II path first, then an aggregator for Rivian and other makes. Each adapter outputs the unified vehicle record shown in Admin → Vehicles & OEMs.
5. **Payments and messaging.** Mobile money and card payments for booking and no-show fees; SMS/push notifications.
6. **Maps.** A real routing engine and live traffic, replacing the schematic Greater Accra network.
