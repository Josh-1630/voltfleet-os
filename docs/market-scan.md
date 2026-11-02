# VoltFleet market scan: vehicle data, chargers and charging software

November 2026. Desk research from public sources; vendor claims are marked as such. Verify coverage, pricing and terms with each vendor before committing.

## 1. Vehicle data APIs (how VoltFleet reads the car)

| Provider | What it is | Fit for VoltFleet |
| --- | --- | --- |
| **Smartcar** | Developer API across many car brands, via the owner's carmaker account. **API v3** (launched 22 April 2026) reads vehicle "signals" (`/v3/vehicles/{id}/signals`) with one application token (OAuth client credentials, valid 1 hour) plus an `sc-user-id` header; commands such as `/commands/charge/start`. **v2.0 is deprecated on 1 December 2026.** Has a vehicle simulator (`mode=simulated`). | Now integrated (see below). Coverage is strongest in North America and Europe: confirm Ghana and the brands GreenLine actually drives (BYD, MG, Chinese-spec imports) with Smartcar's compatibility API before relying on it in Accra. |
| **High Mobility** | Unified API to live data through official OEM partnerships, mostly European brands. | Closest alternative to Smartcar for OEM-direct data. |
| **Enode** | Energy-focused API (EVs, chargers, solar, batteries) for energy retailers and smart charging. Mainly Europe. | Good model for smart charging tied to tariffs; less relevant for Ghana today. |
| **Geotab** | Hardware telematics (plug-in device), GPS, driver behaviour, EV fleet reports. A finished product rather than an API to build on. | The practical route for vehicles no API covers: Chinese-spec imports and older EVs. VoltFleet's OBD-II dongle path plays the same role. |

**Takeaway:** use two data paths, the same split VoltFleet Connect already models: carmaker APIs (Smartcar, High Mobility) where the brand and country are covered, and a plug-in dongle for everything else.

## 2. Charger hardware: XCharge and similar

**XCharge (XCHG Limited, Nasdaq: XCH)**, Beijing, founded 2015, with XCharge Europe and XCharge North America.
- Products: C6/C7 DC fast chargers; **Net Zero Series** and **GridLink**, battery-integrated DC fast chargers. GridLink delivers up to 300 kW and stores energy in its own battery, so it can charge cars quickly on a weak grid connection. It won awards in 2025 and 2026.
- Protocols: GridLink in Europe supports **OCPP 1.6J and 2.0.1** over GSM, LTE or LAN. The older C6 supported OCPP 1.6 JSON or XCharge's own protocol. XCharge also runs its own energy management system and a cloud platform.
- Business: FY2025 revenue about US$25 million with a US$32.5 million loss (reported figures). Multi-year framework agreement with EnBW (Germany) in February 2026; assembly site in Spain.

**Why it matters for Ghana:** battery-buffered chargers keep charging through weak supply and load shedding, and cut peak demand charges. VoltFleet should treat them as first-class: read the charger's battery level and grid draw as well as connector status, and plan bookings around stored energy.

## 3. Charging management software (CSMS)

| Platform | Positioning |
| --- | --- |
| **Driivz** | Hardware-agnostic platform for operators, utilities and fleets running mixed charger brands; strong smart charging; enterprise pricing. |
| **AMPECO** | Hardware-agnostic, white-label, OCPP, roaming, smart energy and an open API. |
| **ChargePoint** | Own hardware plus software. Manages its own and many OCPP chargers; fleet depot, home and on-road charging with home-charging reimbursement. |
| **EV Connect** | Works best with its own or certified hardware. |
| **Monta** | Works with 600+ charger models; depot product with "Car Integration" that shows each vehicle's battery, charging state and location. |

Third-party guides group Driivz, AMPECO, Monta, Etrel and WeaveGrid as the most mature at smart charging. Independent operators with mixed hardware tend to choose OCPP-native platforms.

## 4. Fleet charging optimisation

- **Ampcontrol:** connects to vehicle telematics, plans charging up to 24 hours ahead to hit departure times, and optimises for time-of-use and spot prices, with GPS and route context.
- **The Mobility House, ChargePilot:** depot charging and energy management, sold with planning, installation and maintenance.
- **Monta (depot):** car-level integration alongside charger control.

## 5. What VoltFleet should take from this

1. **OCPP 1.6J now, 2.0.1 next.** It's the common language of XCharge, ABB, Kempower and most chargers, and what Driivz, AMPECO and Monta are built on. VoltFleet's operator console already mirrors OCPP states; the next step is a real central system.
2. **Departure-aware smart charging.** Combine telematics state of charge (now available through Smartcar) with each vehicle's next job and the tariff bands already in the app, as Ampcontrol does. The Energy Analytics page already shows the peak vs off-peak saving to aim for.
3. **Battery-buffered and grid-aware charging for Ghana.** Support XCharge-style chargers' stored energy and plan around load shedding. This is a gap most US and EU platforms don't need to solve.
4. **Two vehicle data paths.** A carmaker API where it's covered, a dongle elsewhere, and confirm Smartcar's coverage in Ghana early.
5. **Open later:** OCPI roaming with other networks, and white-label consoles for operators (AMPECO's model).

## Sources

- Smartcar: [Introducing API v3](https://smartcar.com/blog/introducing-smartcar-api-v3), [API authentication](https://smartcar.com/docs/getting-started/how-to/api-authentication), [List signals](https://smartcar.com/docs/api-reference/list-signals), [Get signal](https://smartcar.com/docs/api-reference/get-signal), [Start charging](https://smartcar.com/docs/api-reference/charging/start-charging), [Build the Connect URL](https://smartcar.com/docs/connect/redirect-to-connect), [Handle the response](https://smartcar.com/docs/connect/handle-the-response), [Compatible vehicles](https://smartcar.com/docs/api-reference/compatible-vehicles), [Vehicle simulator](https://smartcar.com/docs/help/vehicle-simulator), [v2 overview](https://smartcar.com/docs/api-reference/v2-overview), [Changelog](https://smartcar.com/docs/changelog/latest)
- Vehicle APIs: [High Mobility](https://high-mobility.com/blog/smart-car-api), [Smartcar vs Enode](https://smartcar.com/enode), [Geotab vs Smartcar (CB Insights)](https://www.cbinsights.com/compare/geotab-vs-smartcar)
- XCharge: [GridLink in Europe (Automotive World)](https://www.automotiveworld.com/news-releases/xcharge-launches-gridlink-across-europe-powered-by-proprietary-battery-technology-for-enhanced-safety), [electrive](https://www.electrive.com/es/2025/09/02/from-the-us-to-europe-xcharge-brings-gridlink-to-berlin/), [GridLink 2026 E+E award](https://environmentenergyleader.com/awards/2026/xcharge/), [C6EU datasheet](https://www.tsg-solutions.com/app/uploads/2019/01/XCHARGE_datasheet_C6EU_english.pdf), [Edgar Tools profile](https://app.edgar.tools/companies/XCH), [American Companies](https://americancompanies.com/company/xchg-ltd/), [GridLink North America (Nasdaq)](https://www.nasdaq.com/press-release/xcharge-north-america-introduces-gridlink-new-solution-ev-charging-and-grid)
- CSMS: [Driivz vs AMPECO (rfp.wiki)](https://www.rfp.wiki/vendors/driivz/ampeco), [ChargePoint vs AMPECO](https://www.rfp.wiki/vendors/chargepoint/ampeco), [Ampcontrol: best charging management systems](https://www.ampcontrol.io/post/the-best-charging-management-software-systems-for-charging-sites)
- Fleet charging: [Ampcontrol fleet charging](https://www.ampcontrol.io/electric-fleet-charging), [Ampcontrol telematics](https://ampcontrol.io/products/vehicle-telematics), [Monta depot](https://monta.com/uk/business-solutions/depot-fleet/), [The Mobility House full service](https://www.mobilityhouse.com/usa_en/solutions/full-service)
