# VoltFleet OS: competitive positioning

November 2026. Built from *EV Systems Market Analysis and VoltFleet Strategic Positioning* and the desk research in `docs/market-scan.md`. Competitor capabilities are summarised from their public product descriptions and change often. Check them before using this in a pitch.

## The gap

The market analysis finds the same pattern in every region: charging and dispatch are planned by hand, the data sits in separate systems, and energy prices and grid conditions don't feed into fleet decisions. In Ghana and across Africa there is a second gap. Most tools assume a reliable grid, a fast connection and a card payment, and in practice fleets have none of these.

VoltFleet's position is **one operating system that decides, not just reports**. It runs on any make of vehicle or charger and is designed first for weak grids and patchy networks. On top of that it offers features at the level of the best European tools.

## Where each type of competitor stops

| Category | Examples | What they do well | Where they stop |
| --- | --- | --- | --- |
| Carmaker apps | BYD, Hyundai, Tesla fleet apps | Deep data for their own brand | One brand only; no charging, energy or dispatch view |
| Telematics built for fuel fleets | Geotab, Samsara, Webfleet | GPS, driver behaviour, hardware reach | EV features added on top; charging and energy not optimised together |
| Charger management systems (CSMS) | Driivz, AMPECO, ChargePoint, Monta | Running chargers, payments, roaming | See the charger, not the vehicle's mission or route |
| Depot smart charging | Ampcontrol, The Mobility House | Load management, tariff optimisation | Not a fleet operating system: no routing, maintenance or finance |
| Energy APIs | Enode, ev.energy | Tariff-based charging for households and utilities | Built for homes and utilities, mostly Europe |
| Battery swap and e-moto networks | Spiro, Ampersand, Kofa (Africa) | Hardware and energy for two-wheelers | Vertical networks; partners for VoltFleet, not substitutes |

## VoltFleet vs the field (what's in the product today)

| Capability | VoltFleet | Fuel-fleet telematics | Charger systems | Depot charging tools |
| --- | --- | --- | --- | --- |
| Any vehicle make in one view (Smartcar + OBD-II) | ✅ | ✅ (hardware) | — | partly |
| Real chargers over OCPP 1.6J, any brand | ✅ | — | ✅ | ✅ |
| Charging ordered by each vehicle's next mission (Smart Queue) | ✅ | — | partly | ✅ |
| Time-of-use **and** hourly day-ahead prices, demand-charge peak shaving | ✅ | — | partly | ✅ |
| **Planning around grid outages** with backup battery or generator | ✅ | — | — | — |
| Solar + depot battery + V2G in one plan | ✅ | — | partly | partly |
| Route optimisation with cargo, hills, weather, traffic and battery ageing | ✅ | partly | — | — |
| Predictive maintenance per component | ✅ | partly | — | — |
| Driver eco-scorecards without location trails | ✅ | ✅ (with GPS) | — | — |
| Mixed fuel + EV fleets with an electrification planner (payback, range fit, depot headroom) | ✅ | partly | — | — |
| Energy cost by client or route, battery depreciation and warranty | ✅ | partly | — | — |
| Home-charging reimbursement **by Mobile Money** | ✅ | — | Card/bank (Europe) | — |
| SMS and WhatsApp alerts in local languages (Twi, Hausa, French) | ✅ | Email/app | App | Email |
| Works offline, low-data mode for 2G/3G | ✅ | partly | — | — |
| Real-time control tower | ✅ | ✅ | partly | partly |
| Open API for partners (VoltFleet Connect) | ✅ | ✅ | ✅ | partly |

✅ = in VoltFleet's product (with simulated data where no live source is connected yet; see the README). "Partly" means the competitor type covers some of it or only through integrations. Fill this in per named competitor after demos.

## Nordic-grade, African-first

Norway is the model for mature EV operations: almost all new cars sold there are electric, and fleets expect hourly price optimisation, capacity-based grid tariffs, reimbursed home charging and solid compliance reporting. VoltFleet includes each of these, adapted to Ghana:

| What a Nordic fleet expects | How VoltFleet does it in Ghana |
| --- | --- |
| Hourly day-ahead price optimisation | Hourly mode for markets that have it; ECG time-of-use today |
| Capacity (peak kW) grid tariffs | Demand-charge peak shaving under the depot's supply limit |
| Home-charging reimbursement | Measured by the vehicle, paid by MTN MoMo, Telecel Cash or AT Money |
| Plug & Charge and roaming | Next: ISO 15118 and OCPI with Ghanaian charge networks |
| ESG and compliance reporting | ESG export with Ghana's grid factor; mapping to the Data Protection Act 2012 (Act 843) |
| Pre-heating in winter | Pre-cooling while plugged in (driver tip; vehicle command next) |
| A reliable grid | Outage-aware charging, battery or generator backup, low-voltage alerts |

## What to build next to stay ahead

1. **Live data behind the simulated parts:** depot meters, OCPP charging profiles for the Smart Queue, Smartcar signals for maintenance, an order feed or webhook for jobs.
2. **Real messaging and payments:** a server-side SMS provider (Hubtel, mNotify, Arkesel or Africa's Talking) and the WhatsApp Business Platform; a licensed Mobile Money aggregator for payouts.
3. **ECG integration:** prepaid meter top-ups and published load-management schedules feeding the outage model.
4. **Battery swap partners** for courier motorbikes and three-wheelers.
5. **Native translations** reviewed by Twi, Ewe, Ga and Hausa speakers, then translate the whole driver app, not just the alerts.
6. **Plug & Charge (ISO 15118-2/-20) and OCPI roaming** so drivers can charge on partner networks without cards.
