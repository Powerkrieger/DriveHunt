'use strict';
// Map markers (Markierungen) for all users: meeting point, stand, parking,
// danger, game seen, other. Everyone can add; own markers (editors: all) can be
// edited, moved and deleted. Markers are permanent location descriptors, so they
// are locked by default — moving is a deliberate step ("Verschieben" in the
// popup), never an accidental drag. Updates arrive live via SSE.

(function () {
  const TYPES = {
    treffpunkt: ['🚩', 'Treffpunkt'],
    hochsitz: ['🪜', 'Hochsitz / Stand'],
    parkplatz: ['🅿️', 'Parkplatz'],
    gefahr: ['⚠️', 'Gefahr'],
    wild: ['🦌', 'Wild gesehen'],
    sonstiges: ['📌', 'Sonstiges'],
  };
  // Colour for the small-dot (decluttered) view.
  const DOT_COLOR = {
    treffpunkt: '#e53935', hochsitz: '#6d4c41', parkplatz: '#1e88e5',
    gefahr: '#fb8c00', wild: '#43a047', sonstiges: '#8e24aa',
  };
  // minimized: show markers as small dots instead of full icons (declutter).
  // placing stays false (kept for app.js field-click guard); moving holds the
  // marker currently being repositioned.
  const Markers = { list: [], placing: false, minimized: false, moving: null };
  window.Markers = Markers;
  let layer, button;

  const canEdit = (m) => state.me.role === 'editor' || m.created_by === state.me.username;
  const fullIcon = (type) =>
    L.divIcon({ className: 'map-marker', html: `<span>${TYPES[type][0]}</span>`, iconSize: [36, 36], iconAnchor: [18, 44], popupAnchor: [0, -40] });
  const dotIcon = (type) =>
    L.divIcon({ className: 'map-dot', html: `<i style="background:${DOT_COLOR[type] || '#555'}"></i>`, iconSize: [14, 14], iconAnchor: [7, 7], popupAnchor: [0, -8] });

  Markers.init = async function () {
    layer = L.layerGroup().addTo(map);
    button = document.getElementById('tb-markers');
    button.addEventListener('click', Markers.toggleDots);

    // Long-press (touch) / right-click (desktop) on empty map adds a marker.
    map.on('contextmenu', (e) => {
      if (window.Lock?.active || window.Measure?.active || window.Sketch?.active || window.FieldEdit?.tool || Markers.moving) return;
      openForm({ lat: e.latlng.lat, lng: e.latlng.lng, type: 'treffpunkt', label: '', note: '' });
    });

    await Markers.reload();
  };

  Markers.reload = async function () {
    Markers.list = await api('GET', '/api/markers');
    render();
  };

  // Switch all markers between full icons and small dots.
  Markers.toggleDots = function () {
    if (window.Tools?.busy?.()) return window.Tools.nudge(); // re-rendering would break a move in progress
    Markers.minimized = !Markers.minimized;
    button.classList.toggle('active', Markers.minimized);
    button.title = Markers.minimized ? 'Markierungen groß zeigen' : 'Markierungen klein zeigen';
    render();
  };

  // Called by other tools before they activate; abort any pending move.
  Markers.stop = () => { if (Markers.moving) cancelMove(); };

  function render() {
    layer.clearLayers();
    for (const m of Markers.list) {
      const mk = L.marker([m.lat, m.lng], {
        icon: Markers.minimized ? dotIcon(m.type) : fullIcon(m.type),
        draggable: false, // locked; moving is deliberate via the popup
        title: m.label || TYPES[m.type][1],
      });
      mk.bindPopup(() => popupContent(m, mk), { minWidth: 220 });
      mk.on('dragend', () => Markers.moving?.mk === mk && saveMove());
      mk.addTo(layer);
    }
  }

  // ---- deliberate move -------------------------------------------------------
  function startMove(m, mk) {
    if (window.Tools?.busy?.()) return window.Tools.nudge();
    window.Measure?.stop?.();
    window.Ext?.closeLayers?.();
    mk.closePopup();
    mk.dragging.enable();
    Markers.moving = { m, mk };
    document.body.classList.add('picking');
    const text = 'Markierung an die neue Stelle ziehen, dann „Fertig“.';
    ActionBar.show({ text, onDone: saveMove, onCancel: cancelMove, onUndo: null });
    ActionBar.update({ text, canDone: true, undo: false });
  }
  async function saveMove() {
    const mv = Markers.moving;
    if (!mv) return;
    const ll = mv.mk.getLatLng();
    try {
      await api('PUT', `/api/markers/${mv.m.id}`, { lat: ll.lat, lng: ll.lng });
      mv.m.lat = ll.lat;
      mv.m.lng = ll.lng;
      endMove();
    } catch (err) {
      alert(err.message);
      mv.mk.setLatLng([mv.m.lat, mv.m.lng]);
    }
  }
  function cancelMove() {
    const mv = Markers.moving;
    if (mv) mv.mk.setLatLng([mv.m.lat, mv.m.lng]);
    endMove();
  }
  function endMove() {
    const mv = Markers.moving;
    Markers.moving = null;
    if (mv) mv.mk.dragging.disable();
    document.body.classList.remove('picking');
    ActionBar.hide();
  }

  const when = (ts) => new Date(ts.replace(' ', 'T') + 'Z').toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });

  function popupContent(m, mk) {
    const div = L.DomUtil.create('div', 'marker-popup');
    div.innerHTML = `
      <b>${TYPES[m.type][0]} ${esc(m.label || TYPES[m.type][1])}</b>
      ${m.label ? `<div class="muted">${TYPES[m.type][1]}</div>` : ''}
      ${m.note ? `<p class="notes">${esc(m.note)}</p>` : ''}
      <div class="muted">von ${esc(m.created_by)} · ${when(m.updated_at)}</div>
      ${canEdit(m) ? '<div class="row"><button data-act="move">Verschieben</button><button data-act="edit">Bearbeiten</button><button data-act="del" class="danger">Löschen</button></div>' : ''}`;
    L.DomEvent.on(div, 'click', async (e) => {
      const act = e.target.dataset?.act;
      if (act === 'move') return startMove(m, mk);
      if (act === 'edit') {
        mk.closePopup();
        openForm(m);
      }
      if (act === 'del' && confirm('Markierung löschen?')) {
        try {
          await api('DELETE', `/api/markers/${m.id}`);
          await Markers.reload();
        } catch (err) {
          alert(err.message);
        }
      }
    });
    return div;
  }

  // Create (no id) or edit a marker. On desktop the form opens in a popup
  // anchored to the marker; on phones an anchored bubble is cramped and sits
  // off to the side, so there it opens as a centred modal instead.
  function openForm(m) {
    const div = L.DomUtil.create('div', 'marker-form');
    div.innerHTML = `
      <label>Art <select name="type">${Object.entries(TYPES)
        .map(([k, [e, name]]) => `<option value="${k}" ${k === m.type ? 'selected' : ''}>${e} ${name}</option>`)
        .join('')}</select></label>
      <label>Bezeichnung <input name="label" maxlength="100" placeholder="optional" /></label>
      <label>Notiz <textarea name="note" rows="2" maxlength="1000" placeholder="optional"></textarea></label>
      <div class="row"><button data-act="save" class="primary">Speichern</button><button data-act="cancel">Abbrechen</button></div>
      <p class="error"></p>`;
    div.querySelector('[name=label]').value = m.label || '';
    div.querySelector('[name=note]').value = m.note || '';
    L.DomEvent.disableClickPropagation(div);

    const close = showForm(div, m);
    L.DomEvent.on(div, 'click', async (e) => {
      const act = e.target.dataset?.act;
      if (act === 'cancel') return close();
      if (act !== 'save') return;
      const body = {
        lat: m.lat,
        lng: m.lng,
        type: div.querySelector('[name=type]').value,
        label: div.querySelector('[name=label]').value,
        note: div.querySelector('[name=note]').value,
      };
      try {
        await (m.id ? api('PUT', `/api/markers/${m.id}`, body) : api('POST', '/api/markers', body));
        close();
        await Markers.reload();
      } catch (err) {
        div.querySelector('.error').textContent = err.message;
      }
    });
  }

  // Place the form; returns a close() for the chosen container (modal / popup).
  function showForm(div, m) {
    if (window.matchMedia('(max-width: 700px)').matches) {
      const overlay = L.DomUtil.create('div', 'overlay marker-modal', document.body);
      const card = L.DomUtil.create('div', 'card marker-modal-card', overlay);
      const head = L.DomUtil.create('strong', 'marker-modal-title', card);
      head.textContent = m.id ? 'Markierung bearbeiten' : 'Neue Markierung';
      card.appendChild(div);
      const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
      const onKey = (e) => e.key === 'Escape' && close();
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
      document.addEventListener('keydown', onKey);
      div.querySelector('[name=label]').focus();
      return close;
    }
    const popup = L.popup({
      minWidth: 240,
      maxHeight: Math.round(window.innerHeight * 0.6),
      closeOnClick: false,
      autoPan: true,
      keepInView: true,
      autoPanPaddingTopLeft: [12, 70], // clear the top controls
      autoPanPaddingBottomRight: [12, 24],
    }).setLatLng([m.lat, m.lng]).setContent(div).openOn(map);
    return () => map.closePopup(popup);
  }
})();
