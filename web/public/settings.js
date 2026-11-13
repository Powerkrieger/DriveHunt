'use strict';
// Settings (Einstellungen): a modal opened from the ⚙ button in the panel header.
// Four areas — account (incl. password change), default base map, simulation
// defaults, and appearance/offline. Preferences are per-device in localStorage;
// the password change goes to the server. Relies on globals from app.js
// ($, api, state, setBaseMap) and window.Offline from offline.js.

(function () {
  const KEY = 'dh.settings';
  const TILE_CACHE = 'dh-tiles-v1'; // keep in sync with sw.js
  const DEFAULTS = {
    baseMap: 'osm',
    theme: 'system', // system | light | dark
    sim: { drivers: 12, standers: 4, flank: 40, speed: 3, maxspeed: 5, standerspeed: 1.5 },
  };
  // settings key -> simulation input ids in the panel.
  const SIM_INPUTS = {
    drivers: 'sim-drivers', standers: 'sim-standers', flank: 'sim-flank',
    speed: 'sim-speed', maxspeed: 'sim-maxspeed', standerspeed: 'sim-standerspeed',
  };

  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
      return { ...DEFAULTS, ...raw, sim: { ...DEFAULTS.sim, ...(raw.sim || {}) } };
    } catch {
      return { ...DEFAULTS, sim: { ...DEFAULTS.sim } };
    }
  }
  function save(s) {
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode: keep this session only */ }
  }

  let current = load();

  function applyTheme(theme) {
    const el = document.documentElement;
    if (theme === 'light' || theme === 'dark') el.setAttribute('data-theme', theme);
    else el.removeAttribute('data-theme');
  }
  // Apply the theme as early as possible to avoid a flash.
  applyTheme(current.theme);

  const Settings = {
    get: () => current,
    defaultBaseMap: () => current.baseMap,

    // Push the saved simulation defaults into the panel's inputs.
    applySimDefaults() {
      for (const [k, id] of Object.entries(SIM_INPUTS)) if ($(id)) $(id).value = current.sim[k];
      if ($('setup-ndrivers')) $('setup-ndrivers').value = current.sim.drivers;
      if ($('setup-nstanders')) $('setup-nstanders').value = current.sim.standers;
    },

    init() {
      fillForm();
      $('settings-open').addEventListener('click', open);
      $('settings-close').addEventListener('click', close);
      $('settings').addEventListener('click', (e) => { if (e.target.id === 'settings') close(); });

      $('set-basemap').addEventListener('change', (e) => {
        current.baseMap = e.target.value; save(current);
        if (typeof setBaseMap === 'function') setBaseMap(current.baseMap);
      });
      $('set-theme').addEventListener('change', (e) => {
        current.theme = e.target.value; save(current); applyTheme(current.theme);
      });

      for (const [k, _id] of Object.entries(SIM_INPUTS)) {
        $(`set-sim-${k}`).addEventListener('change', (e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) { current.sim[k] = v; save(current); Settings.applySimDefaults(); }
        });
      }
      $('set-sim-reset').addEventListener('click', () => {
        current.sim = { ...DEFAULTS.sim }; save(current); fillSim(); Settings.applySimDefaults();
      });

      $('set-todos')?.addEventListener('click', () => { close(); window.Todos?.open?.(); });
      $('pw-form').addEventListener('submit', changePassword);
      $('set-offline-dl').addEventListener('click', downloadTiles);
      $('set-offline-clear').addEventListener('click', clearTiles);
    },
  };
  window.Settings = Settings;

  function fillSim() {
    for (const k of Object.keys(SIM_INPUTS)) $(`set-sim-${k}`).value = current.sim[k];
  }
  function fillForm() {
    $('set-basemap').value = current.baseMap;
    $('set-theme').value = current.theme;
    fillSim();
    if (state.me) {
      $('set-user').textContent = state.me.username;
      const editor = state.me.role === 'editor';
      const badge = $('set-role');
      badge.textContent = editor ? 'Bearbeiter' : 'Betrachter';
      badge.classList.toggle('editor', editor);
    }
  }

  function open() {
    if (window.Tools?.busy?.()) return window.Tools.nudge(); // finish/cancel the current action first
    // Only one tool / modal at a time (mirrors todos.js).
    window.Measure?.stop?.();
    window.Ext?.closeLayers?.();
    window.Todos && document.getElementById('todos').classList.add('hidden');
    fillForm();
    $('pw-msg').textContent = '';
    $('pw-msg').className = 'msg';
    $('set-offline-msg').textContent = '';
    $('settings').classList.remove('hidden');
    refreshOfflineStats();
  }
  function close() { $('settings').classList.add('hidden'); }

  async function changePassword(e) {
    e.preventDefault();
    const msg = $('pw-msg');
    const cur = $('pw-old').value, next = $('pw-new').value, again = $('pw-new2').value;
    if (next !== again) { msg.textContent = 'Die neuen Passwörter stimmen nicht überein.'; msg.className = 'msg error'; return; }
    if (next.length < 6) { msg.textContent = 'Neues Passwort muss mindestens 6 Zeichen haben.'; msg.className = 'msg error'; return; }
    try {
      await api('POST', '/api/password', { current: cur, next });
      msg.textContent = '✓ Passwort geändert.'; msg.className = 'msg ok';
      $('pw-form').reset();
    } catch (err) {
      msg.textContent = err.message; msg.className = 'msg error';
    }
  }

  // ---- offline tiles ----

  function fmtSize(bytes) {
    if (!bytes) return '0 MB';
    const mb = bytes / 1048576;
    return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(0)} MB`;
  }
  async function refreshOfflineStats() {
    const el = $('set-offline-stats');
    let tiles = 0, usage = 0;
    try { tiles = (await (await caches.open(TILE_CACHE)).keys()).length; } catch { /* no Cache API */ }
    try { if (navigator.storage?.estimate) usage = (await navigator.storage.estimate()).usage || 0; } catch { /* ignore */ }
    el.textContent = `${tiles} Kartenkacheln gespeichert · ca. ${fmtSize(usage)} belegt.`;
  }

  let dlRunning = false, dlCancel = false;
  async function downloadTiles() {
    const btn = $('set-offline-dl'), msg = $('set-offline-msg');
    if (!window.Offline) { msg.textContent = 'Offline-Funktion nicht verfügbar.'; msg.className = 'msg error'; return; }
    if (dlRunning) { dlCancel = true; return; }
    const bounds = window.Offline.townBounds();
    const [zmin, zmax] = window.Offline.zoomRange;
    dlRunning = true; dlCancel = false;
    btn.textContent = 'Stopp'; btn.classList.remove('primary');
    msg.className = 'msg';
    msg.textContent = `Lade Högel (Zoom ${zmin}–${zmax}, ca. ${window.Offline.tileCount(bounds)} Kacheln)…`;
    try {
      const r = await window.Offline.download(
        bounds,
        (d, t, f) => { msg.textContent = `Lade Kacheln… ${d}/${t}${f ? ` (${f} fehlgeschlagen)` : ''}`; },
        () => dlCancel
      );
      msg.textContent = r.cancelled
        ? `Abgebrochen. ${r.total - r.failed}/${r.total} geladen.`
        : `✓ Offline-Karte gespeichert (${r.total - r.failed}/${r.total}${r.failed ? `, ${r.failed} fehlgeschlagen` : ''}).`;
      msg.className = r.cancelled ? 'msg' : 'msg ok';
    } catch (err) {
      msg.textContent = err.message; msg.className = 'msg error';
    } finally {
      dlRunning = false; dlCancel = false;
      btn.textContent = 'Karten für Högel laden'; btn.classList.add('primary');
      refreshOfflineStats();
    }
  }

  async function clearTiles() {
    const msg = $('set-offline-msg');
    if (!confirm('Alle offline gespeicherten Kartenkacheln löschen?')) return;
    try {
      await caches.delete(TILE_CACHE);
      msg.textContent = '✓ Gespeicherte Karten gelöscht.'; msg.className = 'msg ok';
    } catch {
      msg.textContent = 'Konnte den Cache nicht leeren.'; msg.className = 'msg error';
    }
    refreshOfflineStats();
  }
})();
