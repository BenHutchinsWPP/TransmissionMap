# Weekly refresh 2026-10-08

Mode: dry_run. Rows are AI-extracted, each checked against a quote on its page; every new row is unconfirmed until reviewed.

Rows: 4 moratoriums, 1 bans, 1 utilities, 3 updates. Leads: 6. Confirmed unchanged: 1.
Search requests: 25. Pages fetched: 13 (rate 0.923). Model calls: 23, refusals 1.

## Caps hit

- none

## Search errors

- none

## Seed pages

- https://www.savrn.com/data-center-moratorium-tracker: 2 cited URLs kept, 1 dropped
- https://datacenterbans.com/: fetch failed (http_404)
- https://dcmap.us/: fetch failed (http_404)
- https://servercountry.org/: fetch failed (http_404)
- https://writing.strisker.com/: fetch failed (http_404)
- https://www.nj.gov/pinelands/landuse/amend/ords.shtml: fetch failed (http_404)
- https://efts.sec.gov/LATEST/search-index?q=%22data%20center%22%20moratorium&dateRange=custom&startdt=2026-09-24&enddt=2026-10-08: fetch failed (http_404)
- https://efts.sec.gov/LATEST/search-index?q=%22data%20center%22%20%22pause%22%20%22new%20load%22&dateRange=custom&startdt=2026-09-24&enddt=2026-10-08: fetch failed (http_404)
- https://efts.sec.gov/LATEST/search-index?q=%22large%20load%22%20moratorium%20%22data%20center%22&dateRange=custom&startdt=2026-09-24&enddt=2026-10-08: fetch failed (http_404)

## Leads

- seed citation not in page: https://www.savrn.com/data-center-moratorium-tracker | cited https://ridgefield.example.com/made-up-citation
- fetch failed: https://www.glenwoodtribune.example.com/2026/10/03/glenwood-moratorium | http_404
- no county: OH Washington Township | https://www.countyherald.example.com/2026/10/06/washington-township-moratorium | Trustees adopted a 12-month moratorium on data center zoning applications.
- quote not found on page: OH Springfield | https://www.brooksidebeacon.example.com/2026/10/02/brookside-zoning-workshop | City Commission adopted a one-year moratorium on data centers.
- quote not found on page: MI Oak Grove | https://www.oakgroveobserver.example.com/2026/10/01/oak-grove-pause | Village Council approved a nine-month moratorium on data centers.
- model refused: https://www.metroweekly.example.com/2026/10/04/data-center-opinion

## Rejected in review

7 changes reviewed, 7 accepted. A rejected change is not written; publish it by adding its row to this folder's CSVs, citing a page.

- none

## Utilities without an EIA id

- add-ks-riverbend-electric-cooperative-2026: will not be drawn until its EIA-861 eia_id is added

## Confirmed unchanged

- sweep-mi-tamarack-township-2026: https://www.tamarackreporter.example.com/2026/10/05/moratorium-nears-end
