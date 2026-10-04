// MAVO Lumicurve brew log: pulls the scale's debug log over Web Bluetooth,
// keeps every pull in IndexedDB and derives the brew list from it.

// The version tag index.html loaded this file with (see tools/stamp.py); shown in the footer.
const VERSION = typeof document !== "undefined" && document.currentScript
  ? new URL(document.currentScript.src).searchParams.get("v") : null;

// ---------- Log parsing (pure, also used by the Node test) ----------

const RE_WEIGHT = /\[SW\] (?:com )?(?:restart=(-?\d+),|lock=\d+-(\d+)-(\d),)/;
const RE_DONE = /\[MP\] weight num (\d+) time (\d+)/;
const RE_STEP = /\[MP\] change step (\d+) 10$/;
const RE_CLOCK = /^\[([ \d]+):([ \d]+):([ \d]+)\]/;
const RE_DATE = /\[SYS\] Date:(\d+)-(\d+)-(\d+)/;
const RE_RTC = /\[RTC\] set utc ts=(\d+),zone=(-?\d+)/;
const REAL_FROM = Date.UTC(2025, 0, 1) / 1000 / 86400; // scale dates before this are its unset default
const MODES = { 11: "espresso", 9: "pour-over" }; // screen the brew was stopped from
const DAY = 86400;

// pulls: [{id, time, text, imported}] oldest first. Parser state carries across pulls.
//
// Real dates: every sync sets the scale's clock, so its log normally carries true local
// time. The clock falls back to a default date when the scale reboots or charges; it
// still runs steadily, so the next sync pins the last log line to the phone's time and
// brews since that restart are dated by counting back. Anything older than a restart
// with an unset clock keeps only its scale clock.
function parseBrews(pulls) {
  const brews = [];
  let grams = null, mode = "?", flag = "", seen = null, dose = null, settled = null, pourDose = null;
  let era = 0, day = 0, lastDate = null, prevSecs = null, now = 0, real = false;
  for (const pull of pulls) {
    const lines = pull.text.split("\n");
    const first = brews.length;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const c = RE_CLOCK.exec(line);
      if (c) {
        const secs = parseInt(c[1], 10) * 3600 + parseInt(c[2], 10) * 60 + parseInt(c[3], 10);
        const d = RE_DATE.exec(line);
        const rtc = RE_RTC.exec(line);
        if (rtc) {
          // Clock set by a sync: the lines that follow are in real local time.
          era++;
          real = true;
          lastDate = day = Math.floor((parseInt(rtc[1], 10) + parseInt(rtc[2], 10) * 3600) / DAY);
          prevSecs = null;
          continue;
        }
        if (d) {
          const stamp = Date.UTC(2000 + parseInt(d[1], 10), parseInt(d[2], 10) - 1, parseInt(d[3], 10)) / 1000 / DAY;
          if (lastDate !== null && (stamp < lastDate || stamp > lastDate + 30)) era++; // clock restarted
          lastDate = day = stamp;
          real = stamp >= REAL_FROM && stamp < REAL_FROM + 40 * 365; // "70-1-1" is the reboot default
        } else if (prevSecs !== null && secs < prevSecs - DAY / 2) {
          day++; // passed midnight
        }
        prevSecs = secs;
        now = day * DAY + secs;
      }
      let m = RE_WEIGHT.exec(line);
      if (m) {
        if (m[1] !== undefined) {
          grams = parseInt(m[1], 10) / 20; // live value, 0.05 g steps
        } else {
          settled = grams = (parseInt(m[2], 10) / 10) * (m[3] === "1" ? -1 : 1); // settled value, 0.1 g
          // Espresso dose: grounds weighed in the tared grinder cup, i.e. the last settled
          // 10-20 g reading before the brew is armed. A heuristic, not a logged field.
          if (grams >= 10 && grams <= 20) seen = grams;
        }
      } else if (line.includes("espresso cup start")) {
        dose = seen;
      } else if (line.includes("[MP] change step 8 9")) {
        // Pour-over dose: the coffee resting on the scale when it leaves the setup screen
        // and zeroes for the pour. The scale's own ratio is based on this reading.
        pourDose = settled !== null && settled >= 5 && settled <= 100 ? settled : null;
      } else if ((m = RE_STEP.exec(line))) {
        mode = MODES[m[1]] || "?";
      } else if (line.includes("cup up stop")) {
        flag = "cup lifted early, weight unreliable";
      } else if ((m = RE_DONE.exec(line))) {
        const clock = c ? [c[1], c[2], c[3]].map((x) => String(parseInt(x, 10)).padStart(2, "0")).join(":") : "?";
        brews.push({
          key: pull.id + ":" + i,
          synced: pull.time,
          clock,
          era,
          at: now,
          when: real ? wallClock(now) : null,
          mode,
          dose: mode === "espresso" ? dose : mode === "pour-over" ? pourDose : null,
          weight: grams,
          seconds: parseInt(m[2], 10),
          flag,
        });
        mode = "?"; flag = ""; seen = null; dose = null; pourDose = null;
      }
    }
    if (!pull.imported && pull.time) {
      for (const b of brews.slice(first)) {
        if (!b.when && b.era === era && b.at <= now) b.when = pull.time - (now - b.at) * 1000;
      }
    }
  }
  return brews;
}

// Scale-local seconds since 1970 -> timestamp, reading them as this device's local time.
function wallClock(secs) {
  const u = new Date(secs * 1000);
  return new Date(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate(),
    u.getUTCHours(), u.getUTCMinutes(), u.getUTCSeconds()).getTime();
}

// A dose typed in by hand overrides the one read from the scale's log.
function doseOf(b, n) {
  return (n && n.dose) || b.dose || null;
}

function ratioOf(b, n) {
  const dose = doseOf(b, n);
  return dose && b.weight !== null ? b.weight / dose : null;
}

function flowOf(b) {
  return b.weight !== null && b.seconds ? b.weight / b.seconds : null;
}

// Two decimals, like the ratio. The scale itself shows one decimal, cut off without
// rounding up, so 1.37 here reads as 1.3 on its screen.
function flowText(f) {
  return f.toFixed(2);
}

// Brews typed in by hand live in the notes store (key "manual:…") and are slotted into
// the scale's list by time. Log brews without a date keep their place in log order.
function withManual(parsed, notes) {
  let last = 0;
  const all = parsed.map((b, i) => {
    if (b.when) last = b.when;
    return { ...b, num: i + 1, sort: last };
  });
  for (const n of Object.values(notes)) {
    if (!n.manual) continue;
    all.push({
      key: n.key, manual: true, synced: null, clock: "", mode: n.manual.mode, dose: null,
      weight: n.manual.weight, seconds: n.manual.seconds, flag: "", when: n.manual.when, sort: n.manual.when,
    });
  }
  return all.map((b, i) => [b, i]).sort((x, y) => x[0].sort - y[0].sort || x[1] - y[1]).map((x) => x[0]);
}

function labelOf(b, i) {
  return b.manual ? "manual" : "#" + (b.num || i + 1);
}

// A brew's coffee is a bag picked from the list; notes from before bags existed hold typed text.
function coffeeOf(n, bags) {
  const bag = n && n.bag && bags ? bags[n.bag] : null;
  return bag ? bag.name : (n && n.coffee) || "";
}

function toCsv(brews, notes, bags = {}) {
  const esc = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const head = ["brew", "brewed_at", "synced", "scale_clock", "mode", "dose_g", "dose_source", "yield_g", "ratio", "time_s",
    "avg_flow_g_per_s", "coffee", "roaster", "roast_date", "grinder", "grind", "rating", "taste_notes", "flag"];
  const rows = brews.map((b, i) => {
    const n = notes[b.key] || {};
    if (n.deleted) return null;
    const r = ratioOf(b, n), f = flowOf(b), dose = doseOf(b, n);
    return [b.manual ? "manual" : b.num || i + 1, b.when ? new Date(b.when).toISOString() : "",
      b.synced ? new Date(b.synced).toISOString() : "", b.clock, b.mode,
      dose ? dose.toFixed(1) : "", dose ? (n.dose ? "manual" : "scale") : "",
      b.weight !== null ? b.weight.toFixed(1) : "",
      r ? r.toFixed(2) : "", b.seconds, f ? f.toFixed(2) : "",
      coffeeOf(n, bags), (bags[n.bag] || {}).roaster, (bags[n.bag] || {}).roasted,
      n.grinder, n.grind, n.rating, n.taste, b.flag].map(esc).join(",");
  });
  return [head.join(","), ...rows.filter(Boolean)].join("\n") + "\n";
}

if (typeof module !== "undefined") module.exports = { parseBrews, toCsv, withManual, coffeeOf, clockCommand: () => clockCommand() };

// ---------- Storage ----------

// onWaiting fires when another tab still holds the database in an older format; the open
// then completes by itself as soon as that tab is closed.
function openDb(onWaiting) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("lumicurve", 2); // 2: added the coffee bags store
    req.onupgradeneeded = () => {
      const db = req.result, have = db.objectStoreNames;
      if (!have.contains("pulls")) db.createObjectStore("pulls", { keyPath: "id", autoIncrement: true });
      if (!have.contains("partials")) db.createObjectStore("partials", { keyPath: "id", autoIncrement: true });
      if (!have.contains("notes")) db.createObjectStore("notes", { keyPath: "key" });
      if (!have.contains("bags")) db.createObjectStore("bags", { keyPath: "id" });
    };
    req.onblocked = () => onWaiting && onWaiting();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

// ---------- Bluetooth ----------

const SERVICE = 0xfff0, CH_CMD = 0xfff1, CH_DATA = 0xfff2;
const QUIET_MS = 6000; // give up when the scale stops sending for this long

// 04 06 <unix seconds, little-endian> <UTC offset in hours, top bit = negative> 01 (24 h)
function clockCommand() {
  const offsetMin = -new Date().getTimezoneOffset();
  const hours = Math.trunc(offsetMin / 60);
  const secs = Math.floor(Date.now() / 1000) + (offsetMin - hours * 60) * 60;
  const b = new Uint8Array(8);
  b.set([0x04, 0x06]);
  new DataView(b.buffer).setUint32(2, secs, true);
  b[6] = (hours < 0 ? 0x80 : 0) | Math.abs(hours);
  b[7] = 0x01;
  return b;
}

// Resolves to {text, total, complete}. The scale empties its log once sent, so
// whatever arrives must be kept by the caller, even when incomplete.
async function pullLog(onProgress) {
  const device = await navigator.bluetooth.requestDevice({
    filters: [{ namePrefix: "MAVO" }],
    optionalServices: [SERVICE],
  });
  onProgress("Connecting…");
  const gatt = await device.gatt.connect();
  try {
    const service = await gatt.getPrimaryService(SERVICE);
    const cmd = await service.getCharacteristic(CH_CMD);
    const data = await service.getCharacteristic(CH_DATA);

    const chunks = [];
    let total = null, received = 0, finish, timer;
    const done = new Promise((resolve) => (finish = resolve));
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(finish, QUIET_MS);
    };
    data.addEventListener("characteristicvaluechanged", (ev) => {
      const v = ev.target.value;
      const b = new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice();
      arm();
      if (total === null) {
        if (b.length >= 11 && b[0] === 0x01 && b[2] === 0x01) {
          total = new DataView(b.buffer).getUint32(3, true);
          // The app echoes the announced length back before the transfer.
          data.writeValueWithResponse(Uint8Array.of(0x01, 0x09, 0x02, ...b.slice(3, 11))).catch(() => {});
          if (total === 0) finish();
        }
        return;
      }
      if (received >= total) return; // closing 010103 frame; deliberately not answered
      chunks.push(b.slice(2)); // two-byte sequence header
      received += b.length - 2;
      onProgress(`Receiving ${(received / 1024).toFixed(0)} / ${(total / 1024).toFixed(0)} KB`);
      if (received >= total) finish();
    });

    await cmd.startNotifications();
    await data.startNotifications();
    await cmd.writeValueWithResponse(Uint8Array.of(0x02, 0x00));
    await new Promise((r) => setTimeout(r, 400));
    arm();
    await data.writeValueWithResponse(Uint8Array.of(0x01, 0x01, 0x01));
    await done;
    clearTimeout(timer);
    await cmd.writeValueWithResponse(clockCommand()).catch(() => {}); // after the log, so it stays in one clock

    const bytes = new Uint8Array(received);
    let at = 0;
    for (const c of chunks) { bytes.set(c, at); at += c.length; }
    return { text: new TextDecoder("utf-8").decode(bytes), total, complete: total !== null && received === total };
  } finally {
    if (gatt.connected) gatt.disconnect();
  }
}

// ---------- UI ----------

if (typeof document !== "undefined") (async function main() {
  const $ = (id) => document.getElementById(id);
  const db = await openDb(() => {
    $("status").textContent = "This app is open in another tab or window with an older version. Close that one and this page will continue.";
    $("status").classList.add("bad");
  });
  $("status").textContent = "";
  $("status").classList.remove("bad");
  // If a newer version opens elsewhere later, step aside instead of blocking it.
  db.onversionchange = () => {
    db.close();
    $("status").textContent = "A newer version of the app was opened in another tab. Reload this page.";
    $("status").classList.add("bad");
    $("sync").disabled = true;
  };
  const PAGE_SIZE = 20;
  let brews = [], notes = {}, bags = {}, showDeleted = false, filter = "all", bagFilter = "all", page = 0;
  let editingBag = null;

  const setStatus = (msg, bad) => {
    $("status").textContent = msg;
    $("status").classList.toggle("bad", !!bad);
  };

  async function reload() {
    const pulls = (await tx(db, "pulls", "readonly", (s) => s.getAll())) || [];
    const noteRows = (await tx(db, "notes", "readonly", (s) => s.getAll())) || [];
    notes = Object.fromEntries(noteRows.map((n) => [n.key, n]));
    bags = Object.fromEntries(((await tx(db, "bags", "readonly", (s) => s.getAll())) || []).map((b) => [b.id, b]));
    brews = withManual(parseBrews(pulls), notes);
    render();
    $("empty").hidden = pulls.length > 0;
    refreshCount();
  }

  // Deleting only hides a brew: the raw log it came from is kept, so it can be restored.
  // Type and coffee filters, shared by the list and the counter.
  function matches(b) {
    const n = notes[b.key] || {};
    if (filter !== "all" && b.mode !== filter) return false;
    if (bagFilter === "none") return !coffeeOf(n, bags);
    return bagFilter === "all" || n.bag === bagFilter;
  }

  function refreshCount() {
    const note = (b) => notes[b.key] || {};
    const gone = brews.filter((b) => note(b).deleted && !note(b).purged).length; // in the trash
    const kept = brews.filter((b) => !note(b).deleted).length;
    const shown = brews.filter((b) => !note(b).deleted && matches(b)).length;
    $("count").textContent = !brews.length ? "" : filter === "all" && bagFilter === "all"
      ? `${kept} brew${kept === 1 ? "" : "s"}` : `${shown} of ${kept} brews`;
    $("deleted").hidden = gone === 0;
    $("deleted").textContent = showDeleted ? "Back to brews" : `Show deleted (${gone})`;
    $("purge").hidden = !showDeleted;
    $("purge").textContent = `Empty trash (${gone})`;
  }

  async function addPull(text, time, imported) {
    await tx(db, "pulls", "readwrite", (s) => s.add({ time, text, imported: !!imported }));
  }

  function field(label, el) {
    const wrap = document.createElement("label");
    const span = document.createElement("span");
    span.textContent = label;
    wrap.append(span, el);
    return wrap;
  }

  const bagLabel = (bag) => [bag.name, bag.roaster, bag.roasted && "roasted " + bag.roasted].filter(Boolean).join(" · ");
  const bagList = () => Object.values(bags).sort((a, b) => !!a.finished - !!b.finished || b.added - a.added);
  const brewsWith = (id) => brews.filter((b) => { const n = notes[b.key] || {}; return n.bag === id && !n.deleted; }).length;

  // The bags panel and the coffee filter.
  function renderBags() {
    const all = bagList();
    const open = all.filter((b) => !b.finished).length;
    $("bagcount").textContent = all.length ? `${open} open${all.length > open ? `, ${all.length - open} finished` : ""}` : "none yet";

    const pick = $("bagfilter");
    if (bagFilter !== "all" && bagFilter !== "none" && !bags[bagFilter]) bagFilter = "all";
    pick.replaceChildren(
      Object.assign(document.createElement("option"), { value: "all", textContent: "All coffees" }),
      ...all.map((b) => Object.assign(document.createElement("option"), { value: b.id, textContent: bagLabel(b) + (b.finished ? " (finished)" : "") })),
      Object.assign(document.createElement("option"), { value: "none", textContent: "No coffee set" }),
    );
    pick.value = bagFilter;

    $("baglist").replaceChildren(...all.map((bag) => {
      const row = document.createElement("div");
      row.className = bag.finished ? "bag done" : "bag";
      const text = document.createElement("div");
      const used = brewsWith(bag.id);
      const name = document.createElement("b");
      name.textContent = bag.name;
      const info = document.createElement("small");
      info.className = "muted";
      info.textContent = [bag.roaster, bag.roasted && "roasted " + bag.roasted, `${used} brew${used === 1 ? "" : "s"}`, bag.finished && "finished"].filter(Boolean).join(" · ");
      text.append(name, info);
      const act = (label, fn, cls) => {
        const b = Object.assign(document.createElement("button"), { type: "button", className: "link" + (cls ? " " + cls : ""), textContent: label });
        b.addEventListener("click", fn);
        return b;
      };
      const buttons = document.createElement("div");
      buttons.className = "bagacts";
      buttons.append(
        act("Edit", () => {
          editingBag = bag.id;
          $("b-name").value = bag.name; $("b-roaster").value = bag.roaster || ""; $("b-roast").value = bag.roasted || "";
          $("b-title").textContent = "Edit bag"; $("b-save").textContent = "Save bag"; $("b-cancel").hidden = false;
          $("b-name").focus();
        }),
        // A finished bag stays on the brews that used it but is no longer offered for new ones.
        act(bag.finished ? "Reopen" : "Finished", async () => {
          bag.finished = !bag.finished;
          await tx(db, "bags", "readwrite", (s) => s.put(bag));
          render();
        }),
      );
      if (used === 0) {
        buttons.append(act("Delete", async () => {
          if (!confirm(`Delete the bag "${bag.name}"?`)) return;
          await tx(db, "bags", "readwrite", (s) => s.delete(bag.id));
          delete bags[bag.id];
          render();
        }, "bad"));
      }
      row.append(text, buttons);
      return row;
    }));
  }

  function resetBagForm() {
    editingBag = null;
    for (const id of ["b-name", "b-roaster", "b-roast"]) $(id).value = "";
    $("b-title").textContent = "Add a bag"; $("b-save").textContent = "Add bag"; $("b-cancel").hidden = true;
    $("b-error").textContent = "";
  }

  // Coffees and grinders typed before are offered again on other brews.
  function refreshSuggestions() {
    for (const [id, key] of [["grinders", "grinder"]]) {
      const values = [...new Set(Object.values(notes).map((n) => n[key]).filter(Boolean))];
      $(id).replaceChildren(...values.map((v) => Object.assign(document.createElement("option"), { value: v })));
    }
  }

  function render() {
    const list = $("list");
    list.replaceChildren();
    refreshSuggestions();

    renderBags();

    // Leave the trash view once it is empty, so the list never ends up blank.
    if (showDeleted && !brews.some((b) => { const n = notes[b.key] || {}; return n.deleted && !n.purged; })) showDeleted = false;

    // Newest first, narrowed by the type filter, then cut into pages.
    const visible = [];
    for (let i = brews.length - 1; i >= 0; i--) {
      const { deleted, purged } = notes[brews[i].key] || {};
      if (purged || !!deleted !== showDeleted) continue; // the trash view lists deleted brews only
      if (!matches(brews[i])) continue;
      visible.push(i);
    }
    const pages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
    page = Math.min(page, pages - 1);
    $("filters").hidden = brews.length === 0;
    for (const chip of $("filters").children) chip.classList.toggle("on", chip.dataset.mode === filter);
    $("pager").hidden = pages < 2;
    $("pageinfo").textContent = `Page ${page + 1} of ${pages}`;
    $("newer").disabled = page === 0;
    $("older").disabled = page >= pages - 1;
    $("nomatch").hidden = visible.length > 0 || brews.length === 0;
    refreshCount();

    for (const i of visible.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)) {
      const b = brews[i], n = notes[b.key] || { key: b.key };
      const f = flowOf(b);
      const card = document.createElement("details");
      card.className = n.deleted ? "brew gone" : "brew";

      const sum = document.createElement("summary");
      const top = document.createElement("div");
      top.className = "top";
      const title = document.createElement("strong");
      title.textContent = `${labelOf(b, i)} · ${b.mode}`;
      const when = document.createElement("span");
      when.className = "muted";
      when.textContent = b.when
        ? new Date(b.when).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZoneName: "short" })
        : `scale clock ${b.clock}`;
      if (b.manual) card.classList.add("byhand");
      top.append(title, when);

      const stats = document.createElement("div");
      stats.className = "stats";
      const stat = (v, l) => {
        const d = document.createElement("div");
        const big = document.createElement("b");
        big.textContent = v;
        const small = document.createElement("small");
        small.textContent = l;
        d.append(big, small);
        return d;
      };
      const doseStat = stat("", "dose g"), ratioStat = stat("", "ratio"), ratingStat = stat("", "rating");
      const showRating = () => { ratingStat.firstChild.textContent = n.rating ? "★".repeat(n.rating) : "–"; };
      showRating();
      ratingStat.firstChild.classList.add("stars");
      const showDose = () => {
        const dose = doseOf(b, n), r = ratioOf(b, n);
        doseStat.firstChild.textContent = dose ? dose.toFixed(1) : "Add";
        doseStat.firstChild.classList.toggle("add", !dose);
        ratioStat.firstChild.textContent = r ? "1:" + r.toFixed(2) : "–";
      };
      showDose();
      stats.append(
        doseStat,
        stat(b.weight !== null ? b.weight.toFixed(1) : "–", "yield g"),
        ratioStat,
        stat(`${Math.floor(b.seconds / 60)}:${String(b.seconds % 60).padStart(2, "0")}`, "time"),
        stat(f ? flowText(f) : "–", "g/s"),
        ratingStat,
      );
      sum.append(top, stats);

      // The whole summary toggles the card; the pill just makes that visible.
      const foot = document.createElement("div");
      foot.className = "foot";
      const preview = document.createElement("span");
      preview.className = "preview muted";
      const pill = document.createElement("span");
      pill.className = "pill";
      const showPreview = () => {
        const grindText = n.grind ? `grind ${n.grind}${n.grinder ? ` (${n.grinder})` : ""}` : n.grinder;
        const parts = [coffeeOf(n, bags), grindText, n.taste].filter(Boolean);
        const noted = parts.length > 0 || !!n.rating;
        preview.textContent = [b.flag, ...parts].filter(Boolean).join(" · ");
        pill.textContent = noted ? "Edit notes" : "Add notes";
        pill.classList.toggle("quiet", noted);
      };
      showPreview();
      foot.append(preview, pill);
      sum.append(foot);
      card.append(sum);

      const form = document.createElement("div");
      form.className = "form";
      // Open bags, plus this brew's own bag even if finished, plus any text typed before bags existed.
      const coffee = document.createElement("select");
      const opt = (value, textContent) => Object.assign(document.createElement("option"), { value, textContent });
      coffee.append(opt("", "–"));
      for (const bag of bagList()) if (!bag.finished || bag.id === n.bag) coffee.append(opt(bag.id, bagLabel(bag)));
      if (n.coffee && !bags[n.bag]) coffee.append(opt("typed", `${n.coffee} (typed earlier)`));
      coffee.append(opt("new", "+ Add a coffee bag…"));
      coffee.value = bags[n.bag] ? n.bag : n.coffee ? "typed" : "";
      let picked = coffee.value;
      coffee.addEventListener("change", (ev) => {
        if (coffee.value !== "new") { picked = coffee.value; return; }
        ev.stopPropagation(); // not a real choice: jump to the bags panel instead
        coffee.value = picked;
        $("bags").open = true;
        $("bags").scrollIntoView({ block: "center" });
        $("b-name").focus();
      });
      const grinder = Object.assign(document.createElement("input"), { value: n.grinder || "", placeholder: "Grinder name" });
      grinder.setAttribute("list", "grinders");
      const grind = Object.assign(document.createElement("input"), { value: n.grind || "", placeholder: "Grinder setting" });
      const rating = document.createElement("select");
      for (const v of ["", 1, 2, 3, 4, 5]) {
        rating.append(Object.assign(document.createElement("option"), { value: v, textContent: v ? "★".repeat(v) : "–" }));
      }
      rating.value = n.rating || "";
      const taste = Object.assign(document.createElement("textarea"), { value: n.taste || "", rows: 2, placeholder: "How it tasted" });
      // Clearing the field, or typing the logged value, goes back to the scale's reading.
      const doseInput = Object.assign(document.createElement("input"), {
        type: "number", min: 1, max: 100, step: 0.1, inputMode: "decimal", value: doseOf(b, n) || "",
        placeholder: b.dose ? `Scale logged ${b.dose.toFixed(1)}` : "Not logged by the scale",
      });
      form.append(field(b.dose ? `Dose (g) · scale logged ${b.dose.toFixed(1)}` : "Dose (g)", doseInput));
      doseStat.addEventListener("click", (ev) => {
        ev.preventDefault();
        card.open = true;
        doseInput.focus();
      });
      // A brew entered by hand can have its own figures corrected; they apply on Save.
      let manualEdit = null;
      if (b.manual) {
        const when = Object.assign(document.createElement("input"), { type: "datetime-local", value: localStamp(b.when) });
        const kind = document.createElement("select");
        for (const [v, t] of [["espresso", "Espresso"], ["pour-over", "Pour-over"]]) {
          kind.append(Object.assign(document.createElement("option"), { value: v, textContent: t }));
        }
        kind.value = b.mode;
        const num = (value, extra) => Object.assign(document.createElement("input"), { type: "number", min: 0, value, ...extra });
        const yieldIn = num(b.weight, { step: 0.1, inputMode: "decimal" });
        const mins = num(Math.floor(b.seconds / 60), { step: 1, inputMode: "numeric" });
        const secs = num(b.seconds % 60, { step: 1, max: 59, inputMode: "numeric" });
        const two = document.createElement("div");
        two.className = "two";
        two.append(field("Time, minutes", mins), field("seconds", secs));
        form.append(field("Date and time", when), field("Type", kind), field("Yield (g)", yieldIn), two);
        manualEdit = () => {
          const m = {
            when: new Date(when.value).getTime(), mode: kind.value,
            weight: Math.round(parseFloat(yieldIn.value) * 10) / 10,
            seconds: (parseInt(mins.value, 10) || 0) * 60 + (parseInt(secs.value, 10) || 0),
          };
          return m.when && m.weight > 0 && m.seconds > 0 ? m : null;
        };
      }
      form.append(field("Coffee", coffee), field("Grinder", grinder), field("Grind setting", grind), field("Rating", rating), field("Taste", taste));
      const save = async () => {
        if (coffee.value !== "typed") {
          delete n.coffee;
          if (bags[coffee.value]) n.bag = coffee.value; else delete n.bag;
        }
        Object.assign(n, { grinder: grinder.value.trim(), grind: grind.value.trim(), rating: Number(rating.value) || "", taste: taste.value.trim() });
        const d = Math.round(parseFloat(doseInput.value) * 10) / 10;
        if (d >= 1 && d <= 100 && d !== b.dose) n.dose = d; else delete n.dose;
        if (!n.dose) doseInput.value = b.dose || "";
        showDose();
        notes[b.key] = n;
        await tx(db, "notes", "readwrite", (s) => s.put(n));
        showPreview();
        showRating();
        refreshSuggestions();
        renderBags();
      };
      form.addEventListener("change", save);
      const close = Object.assign(document.createElement("button"), { type: "button", className: "primary", textContent: "Save" });
      close.addEventListener("click", async () => {
        await save();
        if (manualEdit) {
          const m = manualEdit();
          if (!m) return setStatus("That manual brew needs a date, a yield and a time.", true);
          n.manual = m;
          await tx(db, "notes", "readwrite", (s) => s.put(n));
          await reload(); // its place in the list and its figures may have changed
          return setStatus("Brew updated.");
        }
        card.open = false;
      });
      const remove = Object.assign(document.createElement("button"), {
        type: "button", className: "danger", textContent: n.deleted ? "Restore brew" : "Delete brew",
      });
      remove.addEventListener("click", async () => {
        if (!n.deleted && !confirm(`Delete brew ${b.manual ? "(manual entry)" : labelOf(b, i)}? You can restore it later from "Show deleted".`)) return;
        await save();
        if (n.deleted) delete n.deleted; else n.deleted = true;
        await tx(db, "notes", "readwrite", (s) => s.put(n));
        render();
        refreshCount();
      });
      form.append(close, remove);
      card.append(form);
      list.append(card);
    }
  }

  // ----- Manual entry -----

  const localStamp = (ms) => {
    const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000);
    return d.toISOString().slice(0, 16); // value format of <input type="datetime-local">
  };

  $("addmanual").addEventListener("click", () => {
    $("manual").hidden = !$("manual").hidden;
    if (!$("manual").hidden) {
      $("m-when").value = localStamp(Date.now());
      $("manual").scrollIntoView({ block: "center" });
    }
  });
  $("m-cancel").addEventListener("click", () => { $("manual").hidden = true; });
  $("m-save").addEventListener("click", async () => {
    const when = new Date($("m-when").value).getTime();
    const weight = Math.round(parseFloat($("m-yield").value) * 10) / 10;
    const mins = parseInt($("m-min").value, 10) || 0, secs = parseInt($("m-sec").value, 10) || 0;
    const seconds = mins * 60 + secs;
    const dose = Math.round(parseFloat($("m-dose").value) * 10) / 10;
    const problem = !when ? "Pick a date and time." : !(weight > 0) ? "Enter the yield in grams." : !(seconds > 0) ? "Enter the brew time." : "";
    $("m-error").textContent = problem;
    if (problem) return;
    const n = { key: "manual:" + Date.now(), manual: { when, mode: $("m-mode").value, weight, seconds } };
    if (dose >= 1 && dose <= 100) n.dose = dose;
    await tx(db, "notes", "readwrite", (s) => s.put(n));
    for (const id of ["m-yield", "m-dose", "m-min", "m-sec"]) $(id).value = "";
    $("manual").hidden = true;
    filter = "all"; showDeleted = false; page = 0;
    await reload();
    setStatus("Brew added. Open it to add notes.");
  });

  function download(name, text, type) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  $("sync").addEventListener("click", async () => {
    $("sync").disabled = true;
    try {
      const before = brews.length;
      const res = await pullLog((m) => setStatus(m));
      if (res.total === null) {
        setStatus("The scale did not answer the log request. Is it awake and unplugged?", true);
      } else if (!res.complete) {
        // Keep what arrived, but apart from the main log so it cannot be double-counted.
        await tx(db, "partials", "readwrite", (s) => s.add({ time: Date.now(), total: res.total, text: res.text }));
        setStatus(`Transfer stopped early (${res.text.length} of ${res.total} bytes). The partial data was saved separately.`, true);
      } else {
        await addPull(res.text, Date.now());
        await reload();
        const added = brews.length - before;
        setStatus(`Synced. ${added} new brew${added === 1 ? "" : "s"}.`);
      }
    } catch (e) {
      setStatus(e.name === "NotFoundError" ? "No scale selected." : "Sync failed: " + e.message, e.name !== "NotFoundError");
    } finally {
      $("sync").disabled = false;
    }
  });

  const STORES = ["pulls", "partials", "notes", "bags"];

  // A backup holds everything: raw pulls with their sync times, and all notes.
  async function restoreBackup(backup) {
    if (backup.app !== "lumicurve" || !Array.isArray(backup.pulls)) throw new Error("not a Lumicurve backup file");
    const have = await tx(db, "pulls", "readonly", (s) => s.count());
    if (have && !confirm("Replace the history and notes in this browser with the backup?")) return false;
    await new Promise((resolve, reject) => {
      const t = db.transaction(STORES, "readwrite");
      for (const name of STORES) {
        const store = t.objectStore(name);
        store.clear();
        for (const row of backup[name] || []) store.put(row);
      }
      t.oncomplete = resolve;
      t.onerror = t.onabort = () => reject(t.error);
    });
    return true;
  }

  $("import").addEventListener("change", async (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    ev.target.value = "";
    try {
      const text = await file.text();
      if (text.trimStart().startsWith("{")) {
        if (!(await restoreBackup(JSON.parse(text)))) return;
      } else {
        await addPull(text, file.lastModified, true); // a plain log file: history without dates
      }
      await reload();
      setStatus(`Imported ${file.name}.`);
    } catch (e) {
      setStatus("Import failed: " + e.message, true);
    }
  });

  $("deleted").addEventListener("click", () => {
    showDeleted = !showDeleted;
    page = 0;
    render();
  });

  // Emptying the trash drops the brews' notes and hides them for good. The raw log lines
  // stay in storage because the neighbouring brews are worked out from the same text.
  $("purge").addEventListener("click", async () => {
    const trash = Object.values(notes).filter((n) => n.deleted && !n.purged);
    if (!trash.length) return;
    if (!confirm(`Permanently delete ${trash.length} brew${trash.length === 1 ? "" : "s"} and their notes? This cannot be undone.`)) return;
    await new Promise((resolve, reject) => {
      const t = db.transaction("notes", "readwrite");
      for (const n of trash) {
        const tomb = { key: n.key, deleted: true, purged: true };
        notes[n.key] = tomb;
        t.objectStore("notes").put(tomb);
      }
      t.oncomplete = resolve;
      t.onerror = t.onabort = () => reject(t.error);
    });
    page = 0;
    render();
    setStatus(`Permanently deleted ${trash.length} brew${trash.length === 1 ? "" : "s"}.`);
  });

  $("bagfilter").addEventListener("change", () => {
    bagFilter = $("bagfilter").value;
    page = 0;
    render();
  });

  $("b-cancel").addEventListener("click", resetBagForm);
  $("b-save").addEventListener("click", async () => {
    const name = $("b-name").value.trim();
    if (!name) { $("b-error").textContent = "Give the bag a name."; return; }
    const bag = editingBag ? bags[editingBag] : { id: "bag:" + Date.now(), added: Date.now() };
    Object.assign(bag, { name, roaster: $("b-roaster").value.trim(), roasted: $("b-roast").value });
    await tx(db, "bags", "readwrite", (s) => s.put(bag));
    bags[bag.id] = bag;
    resetBagForm();
    render();
    setStatus(`Saved "${name}". Pick it under Coffee in a brew's notes.`);
  });

  $("filters").addEventListener("click", (ev) => {
    const mode = ev.target.dataset.mode;
    if (!mode) return;
    filter = mode;
    page = 0;
    render();
  });

  const turn = (by) => {
    page += by;
    render();
    $("filters").scrollIntoView({ block: "start" });
  };
  $("newer").addEventListener("click", () => turn(-1));
  $("older").addEventListener("click", () => turn(1));

  $("csv").addEventListener("click", () => {
    download(`lumicurve-brews-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(brews, notes, bags), "text/csv");
  });

  $("backup").addEventListener("click", async () => {
    const backup = { app: "lumicurve", version: 1, exported: new Date().toISOString() };
    for (const name of STORES) backup[name] = await tx(db, name, "readonly", (s) => s.getAll());
    download(`lumicurve-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(backup), "application/json");
  });

  if (VERSION) $("version").textContent = `Version ${VERSION}.`;
  if (!navigator.bluetooth) {
    $("sync").disabled = true;
    setStatus("This browser has no Web Bluetooth. Use Chrome or Edge.", true);
  }
  await reload();
})();
