// MAVO Lumicurve brew log: pulls the scale's debug log over Web Bluetooth,
// keeps every pull in IndexedDB and derives the brew list from it.

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

function toCsv(brews, notes) {
  const esc = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const head = ["brew", "brewed_at", "synced", "scale_clock", "mode", "dose_g", "dose_source", "yield_g", "ratio", "time_s",
    "avg_flow_g_per_s", "coffee", "grind", "rating", "taste_notes", "flag"];
  const rows = brews.map((b, i) => {
    const n = notes[b.key] || {};
    if (n.deleted) return null;
    const r = ratioOf(b, n), f = flowOf(b), dose = doseOf(b, n);
    return [i + 1, b.when ? new Date(b.when).toISOString() : "",
      b.synced ? new Date(b.synced).toISOString() : "", b.clock, b.mode,
      dose ? dose.toFixed(1) : "", dose ? (n.dose ? "manual" : "scale") : "",
      b.weight !== null ? b.weight.toFixed(1) : "",
      r ? r.toFixed(2) : "", b.seconds, f ? f.toFixed(2) : "",
      n.coffee, n.grind, n.rating, n.taste, b.flag].map(esc).join(",");
  });
  return [head.join(","), ...rows.filter(Boolean)].join("\n") + "\n";
}

if (typeof module !== "undefined") module.exports = { parseBrews, toCsv, clockCommand: () => clockCommand() };

// ---------- Storage ----------

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("lumicurve", 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("pulls", { keyPath: "id", autoIncrement: true });
      db.createObjectStore("partials", { keyPath: "id", autoIncrement: true });
      db.createObjectStore("notes", { keyPath: "key" });
    };
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
  const db = await openDb();
  let brews = [], notes = {}, showDeleted = false;

  const setStatus = (msg, bad) => {
    $("status").textContent = msg;
    $("status").classList.toggle("bad", !!bad);
  };

  async function reload() {
    const pulls = (await tx(db, "pulls", "readonly", (s) => s.getAll())) || [];
    const noteRows = (await tx(db, "notes", "readonly", (s) => s.getAll())) || [];
    notes = Object.fromEntries(noteRows.map((n) => [n.key, n]));
    brews = parseBrews(pulls);
    render();
    $("empty").hidden = pulls.length > 0;
    refreshCount();
  }

  // Deleting only hides a brew: the raw log it came from is kept, so it can be restored.
  function refreshCount() {
    const gone = brews.filter((b) => (notes[b.key] || {}).deleted).length;
    const kept = brews.length - gone;
    $("count").textContent = brews.length ? `${kept} brew${kept === 1 ? "" : "s"}` : "";
    $("deleted").hidden = gone === 0;
    $("deleted").textContent = showDeleted ? "Hide deleted" : `Show deleted (${gone})`;
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

  function render() {
    const list = $("list");
    list.replaceChildren();
    const coffees = [...new Set(Object.values(notes).map((n) => n.coffee).filter(Boolean))];
    $("coffees").replaceChildren(...coffees.map((c) => Object.assign(document.createElement("option"), { value: c })));

    for (let i = brews.length - 1; i >= 0; i--) {
      const b = brews[i], n = notes[b.key] || { key: b.key };
      if (n.deleted && !showDeleted) continue;
      const f = flowOf(b);
      const card = document.createElement("details");
      card.className = n.deleted ? "brew gone" : "brew";

      const sum = document.createElement("summary");
      const top = document.createElement("div");
      top.className = "top";
      const title = document.createElement("strong");
      title.textContent = `#${i + 1} · ${b.mode}`;
      const when = document.createElement("span");
      when.className = "muted";
      when.textContent = b.when
        ? new Date(b.when).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZoneName: "short" })
        : `scale clock ${b.clock}`;
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
      const doseStat = stat("", "dose g"), ratioStat = stat("", "ratio");
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
        stat(f ? f.toFixed(1) : "–", "g/s"),
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
        const parts = [n.coffee, n.rating ? "★".repeat(n.rating) : "", n.taste].filter(Boolean);
        preview.textContent = [b.flag, ...parts].filter(Boolean).join(" · ");
        pill.textContent = parts.length ? "Edit notes" : "Add notes";
        pill.classList.toggle("quiet", parts.length > 0);
      };
      showPreview();
      foot.append(preview, pill);
      sum.append(foot);
      card.append(sum);

      const form = document.createElement("div");
      form.className = "form";
      const coffee = Object.assign(document.createElement("input"), { value: n.coffee || "", placeholder: "Beans, roaster" });
      coffee.setAttribute("list", "coffees");
      const grind = Object.assign(document.createElement("input"), { value: n.grind || "", placeholder: "Grinder setting" });
      const rating = document.createElement("select");
      for (const v of ["", 1, 2, 3, 4, 5]) {
        rating.append(Object.assign(document.createElement("option"), { value: v, textContent: v ? "★".repeat(v) : "–" }));
      }
      rating.value = n.rating || "";
      const taste = Object.assign(document.createElement("textarea"), { value: n.taste || "", rows: 2, placeholder: "How it tasted" });
      // Clearing the field, or typing the logged value, goes back to the scale's reading.
      const doseInput = Object.assign(document.createElement("input"), {
        type: "number", min: 1, max: 40, step: 0.1, inputMode: "decimal", value: doseOf(b, n) || "",
        placeholder: b.dose ? `Scale logged ${b.dose.toFixed(1)}` : "Not logged by the scale",
      });
      form.append(field(b.dose ? `Dose (g) · scale logged ${b.dose.toFixed(1)}` : "Dose (g)", doseInput));
      doseStat.addEventListener("click", (ev) => {
        ev.preventDefault();
        card.open = true;
        doseInput.focus();
      });
      form.append(field("Coffee", coffee), field("Grind", grind), field("Rating", rating), field("Taste", taste));
      const save = async () => {
        Object.assign(n, { coffee: coffee.value.trim(), grind: grind.value.trim(), rating: Number(rating.value) || "", taste: taste.value.trim() });
        const d = Math.round(parseFloat(doseInput.value) * 10) / 10;
        if (d >= 1 && d <= 40 && d !== b.dose) n.dose = d; else delete n.dose;
        if (!n.dose) doseInput.value = b.dose || "";
        showDose();
        notes[b.key] = n;
        await tx(db, "notes", "readwrite", (s) => s.put(n));
        showPreview();
      };
      form.addEventListener("change", save);
      const close = Object.assign(document.createElement("button"), { type: "button", className: "primary", textContent: "Save" });
      close.addEventListener("click", async () => {
        await save();
        card.open = false;
      });
      const remove = Object.assign(document.createElement("button"), {
        type: "button", className: "danger", textContent: n.deleted ? "Restore brew" : "Delete brew",
      });
      remove.addEventListener("click", async () => {
        if (!n.deleted && !confirm(`Delete brew #${i + 1}? You can restore it later from "Show deleted".`)) return;
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

  const STORES = ["pulls", "partials", "notes"];

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
    render();
    refreshCount();
  });

  $("csv").addEventListener("click", () => {
    download(`lumicurve-brews-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(brews, notes), "text/csv");
  });

  $("backup").addEventListener("click", async () => {
    const backup = { app: "lumicurve", version: 1, exported: new Date().toISOString() };
    for (const name of STORES) backup[name] = await tx(db, name, "readonly", (s) => s.getAll());
    download(`lumicurve-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(backup), "application/json");
  });

  if (!navigator.bluetooth) {
    $("sync").disabled = true;
    setStatus("This browser has no Web Bluetooth. Use Chrome or Edge.", true);
  }
  await reload();
})();
