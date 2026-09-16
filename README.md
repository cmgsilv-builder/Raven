# 🐦‍⬛ Raven

Personal flight-price watcher and travel advisor, delivered as a free installable PWA.

You describe a trip once. Raven watches fares across days and airports, keeps a price
history, and advises **buy now vs wait** — like a personal travel advisor.

## Reference trip (v1)

- **Travellers:** 2 adults + 1 lap infant (under 2)
- **Route:** Eindhoven / nearby airports (AMS, BRU, DUS — user-selectable) → Brazil
- **Window:** February–March 2027, flexible dates

## How it stays free

- **App:** static PWA hosted on GitHub Pages
- **Watcher:** a scheduled GitHub Actions job fetches prices daily and commits them to a JSON history file
- **Price data:** Travelpayouts / Aviasales Data API (free, no per-call cost)

## Status

Bootstrapping. The v1 build is in progress — see the project plan and phases.
