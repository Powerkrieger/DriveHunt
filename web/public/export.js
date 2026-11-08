'use strict';
// A4 PDF export: an export mode with an A4-proportioned "viewfinder" frame on
// the map. Pan/zoom to frame the area, pick Hoch-/Querformat, choose whether to
// show all drives and the number badges, then print → the browser's print
// dialog (Save as PDF) renders a dedicated A4-sized map of exactly that frame.
// Uses DOM tiles + SVG overlays (no canvas), so cross-origin tiles are fine.
// Relies on globals from app.js: $, state, map, huntById, createBaseLayer,
// activeBaseMapKey, typeStyle, arrowLayers, labelMarker, labelPosition,
// boundaryLayer, BOUNDARY_ORANGE, openPanel, closePanel.

(function () {
  const Export = {};
  window.A4Export = Export;

  let active = false, orientation = 'portrait';
  let frame, bar; // on-screen viewfinder elements (frame dims the rest via box-shadow)
  let opts = { all: false, numbers: true, setup: false }; // what the preview/print shows

  const el = (tag, cls, parent) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (parent) parent.appendChild(e);
    return e;
  };
  const ratioWH = () => (orientation === 'portrait' ? 210 / 297 : 297 / 210);

  Export.start = function () {
    if (active) return;
    if (!huntById(state.focusId)) return;
    active = true;
    orientation = 'portrait';
    opts = { all: false, numbers: true, setup: false };
    document.body.classList.add('exporting');
    closePanel();

    frame = el('div', 'a4-frame', document.body);
    buildBar();
    layout();
    setExportMode(opts); // turn the main map into a live preview
    window.addEventListener('resize', layout);
    document.addEventListener('keydown', onKey);
  };

  Export.stop = function () {
    if (!active) return;
    active = false;
    document.body.classList.remove('exporting');
    window.removeEventListener('resize', layout);
    document.removeEventListener('keydown', onKey);
    frame?.remove(); bar?.remove();
    frame = bar = null;
    setExportMode(null); // leave preview mode
    const h = huntById(state.focusId);
    if (h) showFocus(h.id, false); else showList(); // restore the normal view
  };

  const onKey = (e) => {
    if (e.key === 'Escape') Export.stop();
    if (e.key === 'Enter') doExport();
  };

  function buildBar() {
    bar = el('div', 'a4-bar', document.body);
    bar.innerHTML = `
      <div class="a4-seg" role="group" aria-label="Format">
        <button type="button" data-o="portrait" class="active">▯ Hoch</button>
        <button type="button" data-o="landscape">▭ Quer</button>
      </div>
      <label class="check"><input type="checkbox" id="a4-all"> Alle Treiben</label>
      <label class="check"><input type="checkbox" id="a4-nums" checked> Nummern</label>
      <label class="check"><input type="checkbox" id="a4-setup"> Aufstellung</label>
      <span class="a4-spacer"></span>
      <button type="button" id="a4-go" class="primary">Als PDF drucken</button>
      <button type="button" id="a4-cancel">Abbrechen</button>`;
    bar.querySelectorAll('.a4-seg button').forEach((b) =>
      b.addEventListener('click', () => {
        orientation = b.dataset.o;
        bar.querySelectorAll('.a4-seg button').forEach((x) => x.classList.toggle('active', x === b));
        layout();
      })
    );
    const sync = () => {
      opts = { all: $('a4-all').checked, numbers: $('a4-nums').checked, setup: $('a4-setup').checked };
      setExportMode(opts); // live-update the preview
    };
    ['a4-all', 'a4-nums', 'a4-setup'].forEach((id) => $(id).addEventListener('change', sync));
    $('a4-go').addEventListener('click', doExport);
    $('a4-cancel').addEventListener('click', Export.stop);
  }

  // Size & centre the A4 viewfinder within the free area of the screen.
  function layout() {
    const vw = window.innerWidth, vh = window.innerHeight;
    const top = 64, bottom = 88; // clear the top controls and the bottom bar
    const maxW = vw * 0.92, maxH = vh - top - bottom;
    const r = ratioWH();
    let w = maxW, h = w / r;
    if (h > maxH) { h = maxH; w = h * r; }
    const left = (vw - w) / 2, t = top + (maxH - h) / 2;
    Object.assign(frame.style, { width: `${w}px`, height: `${h}px`, left: `${left}px`, top: `${t}px` });
  }

  // Geographic bounds under the viewfinder frame.
  function frameBounds() {
    const r = frame.getBoundingClientRect();
    const m = map.getContainer().getBoundingClientRect();
    const tl = map.containerPointToLatLng([r.left - m.left, r.top - m.top]);
    const br = map.containerPointToLatLng([r.right - m.left, r.bottom - m.top]);
    return L.latLngBounds(tl, br);
  }

  function tilesReady(layer) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      layer.on('load', finish);
      setTimeout(finish, 3500); // fallback: tiles cached, or a slow/stalled server
    });
  }

  async function doExport() {
    if (!active) return;
    const bounds = frameBounds();
    const showAll = opts.all, showNums = opts.numbers;
    const focusHunt = huntById(state.focusId);
    const hunts = showAll ? state.hunts : [focusHunt].filter(Boolean);

    // Build the off-screen A4 page.
    const area = el('div', 'a4-print-area', document.body);
    const page = el('div', `a4-print-page ${orientation}`, area);
    const titleEl = el('div', 'a4-print-title', page);
    titleEl.textContent = showAll ? 'Drückjagd Högel – Treiben' : `Treiben ${focusHunt.seq} – ${focusHunt.name}`;
    const mapDiv = el('div', 'a4-print-map', page);
    setPageSize();

    const go = $('a4-go');
    go.disabled = true; go.textContent = 'Wird erstellt…';

    const pmap = L.map(mapDiv, {
      zoomControl: false, attributionControl: true, zoomSnap: 0,
      fadeAnimation: false, zoomAnimation: false, inertia: false, keyboard: false,
    });
    const base = createBaseLayer(activeBaseMapKey()).addTo(pmap);

    // Town limits for orientation.
    if (boundaryLayer) {
      L.geoJSON(boundaryLayer.toGeoJSON(), {
        interactive: false,
        style: { color: BOUNDARY_ORANGE, weight: 3, fillColor: BOUNDARY_ORANGE, fillOpacity: 0.1 },
      }).addTo(pmap);
    }

    // Fields, coloured like the matching on-screen view.
    const firstHunt = new Map();
    if (showAll) for (const h of state.hunts) for (const id of h.field_ids) if (!firstHunt.has(id)) firstHunt.set(id, h);
    for (const [id, geom] of state.fieldGeom) {
      const landuse = state.fieldLayers.get(id)?.feature?.properties?.landuse;
      const [bc, bo] = typeStyle(landuse);
      let style;
      if (showAll) {
        const h = firstHunt.get(id);
        style = h
          ? { color: h.color, weight: 2, fillColor: h.color, fillOpacity: 0.5 }
          : { color: bc, weight: 1, fillColor: bc, fillOpacity: bo };
      } else {
        style = focusHunt.field_ids.includes(id)
          ? { color: '#000', weight: 2, fillColor: focusHunt.color, fillOpacity: 0.5 }
          : { color: bc, weight: 1, fillColor: bc, fillOpacity: bo * 0.5 };
      }
      L.geoJSON(geom, { interactive: false, style }).addTo(pmap);
    }

    // Direction arrows and (optionally) the number badges.
    for (const h of hunts) {
      if (h.arrow) arrowLayers(h.arrow, h.color).forEach((l) => l.addTo(pmap));
      if (showNums) {
        const pos = labelPosition(h.field_ids);
        if (pos) labelMarker(pos, h.seq, h.color).addTo(pmap);
      }
      if (opts.setup) setupPreviewLayers(h).forEach((l) => l.addTo(pmap));
    }

    const ready = tilesReady(base);
    pmap.fitBounds(bounds, { padding: [0, 0], animate: false });
    await ready;

    const cleanup = () => {
      window.removeEventListener('afterprint', cleanup);
      try { pmap.remove(); } catch {}
      area.remove();
      go.disabled = false; go.textContent = 'Als PDF drucken';
    };
    window.addEventListener('afterprint', cleanup);
    // Give the print layout a moment to settle, then open the dialog.
    setTimeout(() => {
      window.print();
      // Safari/Android WebView may not fire afterprint — clean up defensively.
      setTimeout(() => { if (document.body.contains(area)) cleanup(); }, 1500);
    }, 150);
  }

  // The @page size must match the chosen orientation or a blank page appears.
  function setPageSize() {
    let s = document.getElementById('a4-page-style');
    if (!s) { s = document.createElement('style'); s.id = 'a4-page-style'; document.head.appendChild(s); }
    s.textContent = `@page { size: A4 ${orientation}; margin: 0; }`;
  }

  // Wire the trigger once the map exists.
  const wait = setInterval(() => {
    if (typeof map === 'undefined' || !map) return;
    clearInterval(wait);
    $('focus-export')?.addEventListener('click', () => Export.start());
  }, 200);
})();
