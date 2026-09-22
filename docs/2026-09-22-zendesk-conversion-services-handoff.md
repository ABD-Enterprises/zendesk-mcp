# Zendesk Conversion Services reporting handoff

Date: 2026-09-22

## Completed

- Created and published a private Zendesk Explore dashboard: [Conversion Services | Service Performance](https://gditcsucap.zendesk.com/explore/studio#/dashboards/edit/76303951?preview=true)
- Dashboard ID: `76303951`
- Added reports for ticket volume, backlog aging, active requests by request type, median reply/resolution time, and SLA outcomes.
- Scoped dashboard reports to the `Conversion Services Support` brand and production tickets.
- Added reusable `CS Production tickets` calculated attributes to the Tickets and SLA datasets. The attribute excludes tags `demo_data` and `conversion_services_demo`.

## Current observations

- Last 30 days: 44 tickets.
- Current unsolved backlog: 41 tickets: 1 aged 0–1 day, 16 aged 1–7 days, and 19 aged 7–30 days.
- Request-type report is currently unclassified for the active tickets in Explore; the category is blank for all 41.
- All-time median first reply time: 20.3 hours.
- All-time median full resolution time: 18.6 hours.
- SLA report for the last 30 days shows 3 achieved, 34 breached, and 41 active SLA tickets. These are distinct measures and can overlap.

## Follow-up

- Populate or map the Conversion Services request-type field so the request-type report becomes useful.
- Review SLA definitions and breach reporting before using the dashboard as an operational KPI.
- Share the dashboard with the intended Zendesk roles/groups after review.

## Access note

The dashboard was created through the existing authenticated Zendesk browser session. No API key or token was retrieved or stored.
