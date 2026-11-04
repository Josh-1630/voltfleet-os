# VoltFleet OS — EV Manager

One platform that connects **EV fleets**, **drivers**, **their vehicles** (any make) and **charging stations**, plus **VoltFleet Connect**, an API that other companies build on. It has five role-based apps that share one design system (Electric Teal & Fresh White, light by default with a dark mode):

| App | Who | What it does |
| --- | --- | --- |
| **EV Manager** (default sign-in) | Fleet managers | **Dashboard** with 8 live KPIs (vehicles, active, average battery, energy, charging cost, range, CO₂ saved, available stations), vehicle overview, live map, charging activity, energy/cost/CO₂ charts, utilisation and battery health, quick actions. **My Vehicles** (grid/table, search and filters, detail with battery health, performance, maintenance history and registration, add/remove vehicles). **Charging Stations** (list/map, connector, speed and availability filters, live tariffs, distance, directions, send a vehicle). **Charging Sessions** (live and completed, energy, duration, cost, stop charging, CSV). **Trips & Routes** (journey planner with route map, energy estimate, charging-stop suggestion and dispatch; live journeys; history). **Fleet Management** (depots, vehicle allocation, drivers, utilisation, performance). **Energy Analytics** (consumption vs charged, charging by hour and tariff band, cost, efficiency per vehicle, battery health, sustainability). **Reports** (fleet performance, energy, charging expenditure, sustainability, maintenance; preview and CSV). **Notifications** (filters, read/delete, alert preferences). **Settings** (profile, theme, organisation and depots, integrations, data export and reset). |
| **Driver app** (mobile-first) | EV drivers | Live battery %, range, and driving time left on this charge. Trip progress with battery % on arrival. A warning when the driver won't make it. Chargers on the route, filtered to plugs that fit the car. **One tap to book**: checks live availability of every compatible connector along the route and holds a slot for the arrival time, so there's no queue. Live charging view, bookings, vehicle data, and privacy controls. |
| **Operator console** (CSMS) | Charge point operators | Live view of every station and connector (OCPP states), with power, energy and time per session. Remote commands (stop, unlock, reset, enable/disable). Arriving bookings and a connector timeline. Booking rules, time-of-use prices, and smart charging under each site's grid limit (booked sessions keep full power). Reports and the OCPP message log. |
| **VoltFleet Connect** (developer portal) | Fintechs, insurers, ride-hailing, energy companies | One API for any EV make (battery, charging, start/stop charge, odometer, tyres, location, lock). Apps & keys (client ID/secret, rotate), test vehicles, an API explorer with real error codes, a VIN compatibility check, webhooks (`charge.started`, `charge.completed`, `battery.low`, `vehicle.connected/disconnected`) with signed deliveries, docs and per-vehicle pricing. Drivers grant access through the **Connect consent flow** (pick brand → sign in with the carmaker or pair a plug-in device → approve each permission) and can revoke it in the driver app. |
| **Super admin console** | VoltFleet staff | Network-wide KPIs and map, operators, stations and bookings. Vehicle make integrations (BYD, Tesla, Rivian, Hyundai, Kia, Nissan, VW, Ford, MG, plus a universal OBD-II dongle) with data coverage and a plug compatibility matrix. Users with masked personal data. A privacy and compliance center. The demo clock. |

## Intelligence (v2: the long-term vision)

The EV Manager's **Intelligence** section turns fleet data into decisions. Each module is a real optimiser running in the browser (`js/intel.js`) on sample inputs; the pages are in `js/manager-intel.js`.

| Module | What it does | Goes live when |
| --- | --- | --- |
| **Smart Charging 2.0** | A 24-hour depot charging plan. The **Smart Queue** orders vehicles by how tight their charging window is and when they leave; each vehicle's mission target comes from its next route (distance, cargo, heat and battery age). Energy is placed in the cheapest hours (time-of-use tariff + demand charge) or the lowest-carbon hours, never above the depot's grid supply limit, using rooftop solar and a depot battery. Compared with plug-and-charge: cost, peak demand (peak shaving), carbon and mission readiness. | Depot chargers take OCPP charging profiles (Real chargers) and a site meter reports load |
| **Predictive Maintenance** | Seven components per vehicle (HV battery, cooling, 12 V battery, tyres, brakes, drive unit, charge port), each with a monitored signal and limit. A trend model with uncertainty estimates days to the limit and the chance of reaching it within 30 days. Book service on a low-demand day; completing a work order resets the component. | Telematics stream the signals (Smartcar, OBD-II) |
| **AI Route Optimizer** | Assigns the day's jobs to vehicles (payload and battery limits, time windows), orders stops (2-opt) and picks the departure time. The energy model accounts for traffic by hour, weather (live Open-Meteo forecast for Accra), hills, cargo and battery ageing; toggle each to see its effect. Dispatch all routes in one step. | A job/order feed or TMS is connected |
| **Vehicle-to-Grid** | Parked vehicles act as a virtual power plant: sell energy at the evening peak, recharge off-peak and still leave at their mission target. Net value after recharge cost and battery wear; per-vehicle enrolment; a simulated grid (demand-response) event. Bidirectional support is shown per model, with a "whole fleet" what-if. | ISO 15118-20 bidirectional chargers, V2G-capable vehicles and an export agreement |
| **Impact & ROI** | Cost per km (energy, maintenance, operations) today vs with the modules, uptime, on-time deliveries, CO₂, an ESG report (CSV) and a scale calculator from 10 to 10,000 vehicles. | — |

Weather requests send only Accra's fixed coordinates to Open-Meteo (free, no key); offline, a modelled forecast is used. Tariffs, depot assets (supply limit, chargers, solar, battery) and V2G prices are editable in the pages. All figures are estimates until real meters, chargers and vehicles are connected.

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

- **Street maps:** maps use Leaflet with CARTO's light and dark street tiles (OpenStreetMap data, no key), and journey lines follow real roads through OSRM. Both are set in `window.VOLTFLEET_MAPS` in `js/config.js`. CARTO's free basemaps suit low-traffic and non-commercial use; for a commercial launch take a CARTO licence or switch `provider` to `maptiler` or `mapbox` with a public key restricted to your domain. The public OSRM server is for testing only: run your own OSRM, or set `routing: 'none'`. If tiles can't load (offline or blocked), the app falls back to the built-in schematic map.
- **Real chargers (OCPP 1.6J):** the Supabase Edge Function `supabase/functions/ocpp` is a working central system. Chargers connect to `wss://kwxadepnkyxgspvvqbzo.supabase.co/functions/v1/ocpp/<charge-point-id>` with subprotocol `ocpp1.6` and HTTP Basic auth (security profile 1). It handles BootNotification, Heartbeat, StatusNotification, Authorize, Start/StopTransaction, MeterValues and more, and sends remote start/stop, unlock, reset, availability, trigger, configuration, reservations and charging-profile power limits. In the operator console, **Real chargers** creates a charging network (its access key stays on that device), registers chargers (each gets its own password, shown once), shows live status, power, energy and battery level, the command results and the full OCPP message log, and manages authorised cards (masked on screen). A **simulated charger** runs in the browser (or `node tools/ocpp-charger-sim.mjs <url> <id> <password>`) so you can try everything without hardware. Real charger data stays in a private database schema and never enters the shared demo.
  - **Hosting limit:** Supabase Edge Functions end each connection after about 400 seconds. The server closes cleanly at 370 seconds, chargers reconnect within seconds, and no state is lost (everything is in Postgres; commands wait for the next connection). For production, run the same function on a long-lived Deno host: `SUPABASE_DB_URL=... deno run -A supabase/functions/ocpp/index.ts`.
  - **Next:** OCPP 2.0.1, security profiles 2–3 (TLS client certificates), firmware updates and diagnostics, and linking real chargers to stations and bookings in the driver app.
- **Vehicle telematics (Smartcar):** real vehicles connect through Smartcar API v3. The Supabase Edge Function `supabase/functions/smartcar` holds the secret, runs the Connect hand-off, polls readings (cached 60 s) and sends charge commands; the browser holds only a random access key. Live vehicles appear in EV Manager **only on the device that connected them**: they are never written to the shared demo world (`VF.stateJSON`). To switch it on:
  1. Create an application at dashboard.smartcar.com, add this site's address (for example `https://josh-1630.github.io/voltfleet-os/`) as a redirect URI, and enable vehicle info, VIN, battery, charge, location, odometer and charge control.
  2. In Supabase → Edge Functions → Secrets add `SMARTCAR_CLIENT_ID` and `SMARTCAR_CLIENT_SECRET` (the API credentials). Optionally `ALLOWED_ORIGINS`.
  3. Put the public Connect client ID in `window.VOLTFLEET_SMARTCAR.clientId` in `js/config.js`. Start with `mode: 'simulated'`, then `'live'`.
  Smartcar's coverage is strongest in North America and Europe; confirm Ghana and your brands with its compatibility API. Vehicles it can't reach still need the OBD-II dongle path.
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
- `js/ocpp.js`, `js/ocpp-sim.js`: Real chargers page in the operator console, and the simulated OCPP 1.6J charger; `tools/ocpp-charger-sim.mjs`: the same simulator from a terminal
- `supabase/functions/ocpp/`: the OCPP 1.6J central system (`csms.ts` protocol, `server.ts` WebSocket and management API, `index.ts` Postgres store)
- `js/photos.js`: real vehicle photos (lead image of each model's Wikipedia article, free licences only, credited in Settings → Data & privacy)
- `js/motion.js`: page transitions, count-up numbers, chart animations and the dashboard slideshow (Settings → Appearance → Motion)
- `js/smartcar.js`: live vehicles through Smartcar (connect, poll, charge commands, live vehicle page)
- `supabase/functions/smartcar/`: the Smartcar Edge Function; `supabase/migrations/`: its private tables
- `docs/market-scan.md`: vehicle data APIs, XCharge and other charger and charging-software vendors
- `js/map.js`: street maps (Leaflet tiles, live markers, road routing, schematic fallback); `js/vendor/` holds the BSD-licensed Leaflet
- `js/manager.js`, `js/manager-more.js`: the EV Manager pages
- `js/intel.js`: the v2 optimisers (smart charging, predictive maintenance, route optimisation, V2G, ROI); `js/manager-intel.js`: the Intelligence pages
- `js/driver.js`, `js/operator.js`, `js/admin.js`: the driver, operator and admin apps
- `js/connect.js`: VoltFleet Connect (developer portal, consent flow, simulated API and webhooks)
- `js/cloud.js`, `js/config.js`: cross-device sync through Supabase (`js/vendor/` holds the MIT-licensed supabase-js client)
- `js/app.js`: sign-in, the shell (collapsible sidebar, breadcrumb, global search, notifications, account menu), role-based routing, live updates
- `sw.js`, `manifest.webmanifest`: offline use and install to home screen

## Next steps to production

1. **Backend and auth.** Move from the shared demo world to real Supabase tables with row-level security per role and operator. Phone/email OTP for drivers; SSO + MFA for staff.
2. **OCPP.** A 1.6J central system is live (see above). Next: OCPP 2.0.1, a long-lived host, and driving bookings and load balancing from real chargers.
3. **VoltFleet Connect for real.** An OAuth 2.0 authorization server, a public REST API with rate limits, signed webhooks, and usage-based billing.
4. **Vehicle data adapters.** Smartcar is connected for supported brands and countries; add an OBD-II dongle path for Chinese-spec imports and vehicles Smartcar doesn't reach. Each adapter outputs the unified vehicle record shown in Admin → Vehicles & OEMs.
5. **Payments and messaging.** Mobile money and card payments for booking and no-show fees; SMS/push notifications.
6. **Maps.** Street maps are connected. Next: your own OSRM (or a commercial routing API with live traffic) and a licensed tile plan.
