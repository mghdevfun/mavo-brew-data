# MAVO Lumicurve brew log

A small web app that reads the brew history from a MAVO Lumicurve coffee scale over Bluetooth and
keeps it on your phone or laptop, with notes and a CSV export. No iPhone needed.

**Open the app:** https://mghdevfun.github.io/mavo-brew-data/

This is an unofficial hobby project. It is not affiliated with or supported by MAVO or Lefu.

## Disclaimer

**Use this at your own risk.** The app talks to the scale with commands that were worked out by
observation, not from any official documentation. If your scale misbehaves, loses data or stops
working after you use it, that is your responsibility. The author accepts no liability for damage
to your scale, lost brew data, or any effect on your warranty.

For reference, the app sends the scale three things: a query for the connection's packet size, a
request for its debug log (which the scale then clears from its own memory), and the current time.
It never writes firmware or settings.
It was tested on one scale with firmware 008.06; other firmware versions may behave differently.

## What it does

- Connects to the scale from Chrome and saves each brew: dose, yield, ratio, time and average flow.
- Records the real date and time of each brew.
- Lets you add notes per brew: coffee, grind setting, a rating and how it tasted.
- Lets you correct the dose, and delete (and restore) test brews.
- Exports a CSV for spreadsheets and a full backup you can restore on another device.

Everything is stored in the browser on your own device. Nothing is sent to a server.

## What you need

- A MAVO Lumicurve scale (tested on firmware 008.06).
- Chrome or Edge on Android, Windows, macOS, Linux or ChromeOS. These support Web Bluetooth.
- On iPhone or iPad: possibly the free
  [Bluefy](https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055) browser app, but this
  is unproven. See the note below.
- Firefox does not support Web Bluetooth on any system.

### iPhone and iPad: what is and isn't known

Safari, Chrome and every other regular browser on iPhone and iPad run on Safari's engine, which
has no Web Bluetooth. In those browsers the app opens and can show an imported history, but it
cannot sync.

Bluefy is a separate browser app that adds Web Bluetooth. What has been checked so far is only
that the app opens in Bluefy and that Bluefy offers it Bluetooth. **Nobody has yet synced a scale
this way.** Still unknown:

- whether a sync completes and the brews appear
- whether the history survives closing the app, or a few days without opening it (iOS clears
  website data more readily than Android)
- whether the backup and CSV exports produce a file you can save
- whether adding a photo works from the camera and the library

If you try it, export a backup after your first sync and check that the file opens, before you
rely on it. Syncing moves the log off the scale, so a history that iOS later clears is gone.
Reports are welcome in the repository's issues.

## How to use it

1. Wake the scale. It must be running on battery: while charging it shows a battery screen and
   cannot be reached.
2. Open the app and tap **Connect and sync**, then pick `MAVO LUMICURVE` from the list.
3. New brews appear at the top. Tap **Add notes** on a brew to describe it.

On Android, use Chrome's **Add to Home screen** to open it like an app.

### Good habits

- **Sync from one device only.** Syncing moves the entries off the scale (see below), so a second
  device would end up with a different part of the history.
- **Sync before you charge the scale** when you can. Charging resets the scale's clock.
- **Export a backup now and then.** Clearing the site's data in the browser erases the history.

## How it works

The current firmware does not stream weight over Bluetooth, and its on-screen history cannot be
read remotely. What it does offer is a debug log, and that log happens to record every settled
weight, button press and brew.

On each sync the app:

1. Asks the scale for its log and stores the raw text before doing anything else with it.
2. Works out the brews from that log.
3. Sets the scale's clock, so the next log carries real timestamps.

**The scale empties its log once it has been sent.** After a sync, the copy in the app is the only
one. That is why the app keeps the raw log, why deleting a brew only hides it, and why backups
matter.

### Where the numbers come from

| Value | Source |
|---|---|
| Yield, time | Logged by the scale when a brew ends. They match the scale's own history screen. |
| Dose, espresso | The last settled 10–20 g reading before the brew is armed. This assumes you tare the grinder cup, then weigh it with the grounds. |
| Dose, pour-over | The weight on the scale when it leaves the setup screen and zeroes for the pour. |
| Ratio | Yield ÷ dose. |
| Flow (g/s) | Yield ÷ time. The scale calculates its own figure from the curve, so the two can differ by 0.1. |
| Date and time | The scale's clock, set at each sync. After a charge, brews are dated by counting back from the next sync. |

The dose is inferred, not logged as such. If it looks wrong, tap the dose on the brew's card and
correct it. The CSV marks each dose as `scale` or `manual`.

## Limits

- **No curves.** The per-second graph stays on the scale's screen. The log only has each brew's totals.
- **No live weight.** The scale does not transmit while you brew.
- **A tap is needed for every sync.** Browsers do not allow Bluetooth connections in the background.
- **Dates can be missing** for brews made before the first sync, or between a sync and a charge
  if the clock was never set.

## Technical notes

The scale uses a Lefu CK850 Bluetooth module and speaks the base of Lefu's "Torre" protocol on
service `fff0`. It needs no pairing.

| Step | Characteristic | Bytes |
|---|---|---|
| Request the log | `fff2` | `01 01 01` |
| Scale announces the length | `fff2` (notify) | `01 09 01` + length (4 bytes, little-endian) + 4 bytes |
| Echo the length back | `fff2` | `01 09 02` + the same 8 bytes |
| Log data | `fff2` (notify) | 2-byte sequence number + text |
| Set the clock | `fff1` | `04 06` + Unix seconds (little-endian) + UTC offset in hours + `01` |

Useful log lines:

- `[SW] lock=A-B-C,…` is a settled weight: `B` is in 0.1 g steps and `C` is 1 when negative.
- `[SW] restart=N,…` is the weight as it starts to move, in 0.05 g steps.
- `[MP] weight num N time T` marks the end of a brew that ran `T` seconds.
- `[MP] change step 11 10` ends an espresso brew, and `change step 9 10` a pour-over.

The app is two static files with no build step and no dependencies: `index.html` and `app.js`.

## Licence

MIT. See [LICENSE](LICENSE).
