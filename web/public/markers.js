'use strict';
// Map markers (Markierungen) for all users: meeting point, stand, parking,
// danger, game seen, other. Everyone can add; own markers (editors: all) can
// be moved by dragging, edited and deleted. Updates arrive live via SSE.

(function () {
  const TYPES = {
    treffpunkt: ['🚩', 'Treffpunkt'],
    hochsitz: ['🪜', 'Hochsitz / Stand'],
    parkplatz: ['🅿️', 'Parkplatz'],
    gefahr: ['⚠️', 'Gefahr'],
    wild: ['🦌', 'Wild gesehen'],
    sonstiges: ['📌', 'Sonstiges'],
  };
  const Markers = { list: [], placing: false };
  window.Markers = Markers;
  let layer, button;

  const canEdit = (m) => state.me.role === 'editor' || m.created_by === state.me.username;
  const icon = (type) =>
    L.divIcon({ className: 'map-marker', html: `<span>${TYPES[type][0]}</span>`, iconSize: [36, 36], iconAnchor: [18, 44], popupAnchor: [0, -40] });

  Markers.init = async function () {
    layer = L.layerGroup().addTo(map);
    layersControl.addOverlay(layer, 'Markierungen');
    new (L.Control.extend({
      options: { position: 'topleft' },
      onAdd() {
        const bar = L.DomUtil.create('div', 'leaflet-bar marker-control');
        button = L.DomUtil.create('a', '', bar);
        button.href = '#';
        button.title = 'Markierung setzen';
        button.textContent = '📌';
        L.DomEvent.disableClickPropagation(bar);
        L.DomEvent.on(button, 'click', (e) => {
          L.DomEvent.preventDefault(e);
          Markers.placing ? stopPlacing() : startPlacing();
        });
        return bar;
      },
    }))().addTo(map);
    map.on('click', (e) => {
      if (!Markers.placing) return;
      stopPlacing();
      openForm({ lat: e.latlng.lat, lng: e.latlng.lng, type: 'treffpunkt', label: '', note: '' });
    });
    await Markers.reload();
  };

  Markers.reload = async function () {
    Markers.list = await api('GET', '/api/markers');
    render();
  };

  Markers.stop = () => Markers.placing && stopPlacing();

  function startPlacing() {
    // Only one tool / modal at a time.
    Sketch.cancel(true);
    window.Measure?.stop?.();
    map.closePopup();
    Markers.placing = true;
    button.classList.add('active');
    document.body.classList.add('picking');
    ActionBar.show({ text: 'Tippe auf die Karte, wo die Markierung hin soll.', onDone: stopPlacing, onCancel: stopPlacing, onUndo: null });
    ActionBar.update({ text: 'Tippe auf die Karte, wo die Markierung hin soll.', canDone: false, undo: false });
  }
  function stopPlacing() {
    Markers.placing = false;
    button.classList.remove('active');
    document.body.classList.remove('picking');
    ActionBar.hide();
  }

  function render() {
    layer.clearLayers();
    for (const m of Markers.list) {
      const mk = L.marker([m.lat, m.lng], { icon: icon(m.type), draggable: canEdit(m), title: m.label || TYPES[m.type][1] });
      mk.bindPopup(() => popupContent(m, mk), { minWidth: 220 });
      mk.on('dragend', async () => {
        const ll = mk.getLatLng();
        try {
          await api('PUT', `/api/markers/${m.id}`, { lat: ll.lat, lng: ll.lng });
        } catch (err) {
          alert(err.message);
          mk.setLatLng([m.lat, m.lng]);
        }
      });
      mk.addTo(layer);
    }
  }

  const when = (ts) => new Date(ts.replace(' ', 'T') + 'Z').toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });

  function popupContent(m, mk) {
    const div = L.DomUtil.create('div', 'marker-popup');
    div.innerHTML = `
      <b>${TYPES[m.type][0]} ${esc(m.label || TYPES[m.type][1])}</b>
      ${m.label ? `<div class="muted">${TYPES[m.type][1]}</div>` : ''}
      ${m.note ? `<p class="notes">${esc(m.note)}</p>` : ''}
      <div class="muted">von ${esc(m.created_by)} · ${when(m.updated_at)}</div>
      ${canEdit(m) ? '<div class="row"><button data-act="edit">Bearbeiten</button><button data-act="del" class="danger">Löschen</button></div><div class="muted">Zum Verschieben ziehen.</div>' : ''}`;
    L.DomEvent.on(div, 'click', async (e) => {
      const act = e.target.dataset?.act;
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
      autoPanPaddingTopLeft: [12, 70], // clear the top-left controls
      autoPanPaddingBottomRight: [12, 24],
    }).setLatLng([m.lat, m.lng]).setContent(div).openOn(map);
    return () => map.closePopup(popup);
  }
})();
