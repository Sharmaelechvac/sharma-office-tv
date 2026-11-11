# Sharma Office TV

Live: https://sharma-tv.sharma-crew.workers.dev

Daily summary dashboard for an office TV at Sharma Electric & HVAC. Dark, large type, no scrolling, auto-refreshes every 3 minutes. Read only — the app never emails, texts, pays, or submits anything.

This URL is unlisted. The page is not indexed (`noindex`, `X-Robots-Tag`, `robots.txt` disallow). There is no login.

**Footer:** Sharma Electric & HVAC · Lic. EC13013924 · CAC1823596

## What’s on screen

- Live clock and today’s date in America/New_York
- Orlando weather and workday rain chances (Open-Meteo, no API key)
- Today’s crews / active houses by stage, from the crew app
- Inspections today and tomorrow, plus open failed items, from the permit tracker
- Bids due today and this week (builder and project only — never dollar amounts)
- Today’s meetings (times and titles only)
- Scoreboard: houses in progress, and houses finished this month vs a 30/month target when finish dates exist

Nothing sensitive is shown: no cash or AR, no bid amounts, no passwords, no client phone or email, and no qualifier names next to license numbers.

## Deploy

Cloudflare Worker `sharma-tv` with one KV namespace. Hosting is $0 on the existing account.

```
WRANGLER_CACHE_DIR=/tmp/wcache npx wrangler deploy
```

Set the calendar feed secret after the first deploy (stdin only, never commit it):

```
WRANGLER_CACHE_DIR=/tmp/wcache npx wrangler secret put FEED_SECRET
```

Copy `logo-800.png` from the crew app to `public/logo.png` before a fresh deploy if the logo file is not in the checkout. The live Worker already has the logo.

Optional later: `ICS_URL` (a Google private iCal URL, fetched server-side) and `TV_BID_SECRET` (shared secret for the bid tracker TV endpoint).

## Calendar feed

`POST /api/feed/calendar` with header `Authorization: Bearer <FEED_SECRET>` or `X-Feed-Secret`. Body:

```json
{
  "date": "2026-11-09",
  "events": [
    { "time": "9:00 AM", "title": "Builder call" }
  ]
}
```

`date` is optional and defaults to today, Eastern. The panel shows “No meetings” when the list is empty. The app does not read Google Calendar by itself.

## Bid tracker endpoint needed

The bid tracker is passcode-protected and has no TV-safe API yet. This dashboard will call:

`GET https://sharma-bids.sharma-crew.workers.dev/api/tv`

with header `X-TV-Secret: <shared secret>` (set as `TV_BID_SECRET` on this Worker). Expected JSON, no dollar amounts:

```json
{
  "dueToday": [{ "builder": "Name", "project": "Project or address", "date": "2026-11-09" }],
  "dueThisWeek": [{ "builder": "Name", "project": "Project or address", "date": "2026-11-12" }]
}
```

Use follow-up or deadline dates, not bid amounts. Until that endpoint exists, the Bids due panel stays on “Connecting”.

## Images

The logo and review screenshots are listed in `MANIFEST.md`. They live on the box and the live Worker, not in this repo. Do not commit `FEED_SECRET.txt` or any secret values.
