'use strict';
// Device position (GPS): starts automatically and follows you. Shows an
// accuracy circle, a position dot and — when the device has a compass — a cone
// pointing the way you face. The button only re-centres the map (and retries if
// the position was blocked); it is no longer an on/off toggle.
// Also provides window.drivehuntBack() for the Android back button.

(function () {
  let marker, circle, cone, button, lastLatLng = null, heading = null, denied = false, centredOnce = false;

  function render() {
    if (!lastLatLng) return;
    if (!marker) {
      circle = L.circle(lastLatLng, { radius: 0, color: '#1976d2', weight: 1, fillOpacity: 0.12, interactive: false }).addTo(map);
      cone = L.marker(lastLatLng, {
        icon: L.divIcon({ className: 'gps-cone', html: '<i></i>', iconSize: [48, 48], iconAnchor: [24, 24] }),
        interactive: false,
        zIndexOffset: 900,
      }).addTo(map);
      marker = L.circleMarker(lastLatLng, { radius: 8, color: '#fff', weight: 3, fillColor: '#1976d2', fillOpacity: 1, interactive: false }).addTo(map);
    }
    marker.setLatLng(lastLatLng);
    circle.setLatLng(lastLatLng);
    cone.setLatLng(lastLatLng);
    const el = cone.getElement();
    if (el) {
      el.style.visibility = heading == null ? 'hidden' : 'visible';
      if (heading != null) el.querySelector('i').style.transform = `rotate(${heading}deg)`;
    }
  }

  function onFound(e) {
    denied = false;
    lastLatLng = e.latlng;
    if (circle) circle.setRadius(e.accuracy);
    render();
    button?.classList.remove('error');
    button?.classList.add('active');
    if (!centredOnce) {
      centredOnce = true;
      map.setView(e.latlng, Math.max(map.getZoom(), 16));
    }
  }

  function onError(e) {
    // Non-blocking: mark the button instead of interrupting with an alert.
    if (e.code === 1) denied = true; // permission denied / blocked
    button?.classList.remove('active');
    button?.classList.add('error');
    button.title = denied
      ? 'Standort blockiert – in den Geräte-Einstellungen erlauben, dann hier tippen'
      : 'Standort nicht verfügbar – tippen zum erneut versuchen';
  }

  function startWatch() {
    centredOnce = false;
    // No tight timeout: a cold GPS fix outdoors can take 30–60 s; watch keeps
    // running after a transient error and fires locationfound once it locks on.
    map.locate({ watch: true, enableHighAccuracy: true, setView: false, maximumAge: 10000 });
  }

  // Compass heading (where the top of the phone points). Best-effort: not all
  // devices/browsers report an absolute heading, and it never blocks the dot.
  function onOrientation(ev) {
    let h = null;
    if (typeof ev.webkitCompassHeading === 'number') h = ev.webkitCompassHeading; // iOS
    else if (ev.absolute && typeof ev.alpha === 'number') h = 360 - ev.alpha; // Android (absolute)
    if (h == null) return;
    heading = ((h % 360) + 360) % 360;
    render();
  }
  function startCompass() {
    const add = () => {
      window.addEventListener('deviceorientationabsolute', onOrientation, true);
      window.addEventListener('deviceorientation', onOrientation, true);
    };
    const R = window.DeviceOrientationEvent?.requestPermission;
    if (typeof R === 'function') R().then((s) => s === 'granted' && add()).catch(() => {}); // iOS 13+
    else add();
  }

  const LocateControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      const bar = L.DomUtil.create('div', 'leaflet-bar locate-control');
      button = L.DomUtil.create('a', '', bar);
      button.href = '#';
      button.title = 'Auf meinen Standort zentrieren';
      button.textContent = '◎'; // distinct from the 📌 marker button
      L.DomEvent.disableClickPropagation(bar);
      L.DomEvent.on(button, 'click', (e) => {
        L.DomEvent.preventDefault(e);
        if (lastLatLng) map.setView(lastLatLng, Math.max(map.getZoom(), 16));
        else startWatch(); // retry if it never started / was blocked
      });
      return bar;
    },
  });

  const wait = setInterval(() => {
    if (typeof map === 'undefined' || !map) return;
    clearInterval(wait);
    new LocateControl().addTo(map);
    map.on('locationfound', onFound);
    map.on('locationerror', onError);
    startWatch(); // inherently on
    startCompass();
  }, 200);

  // Android back button: close whatever is open; returns true if something was
  // handled, false if the app may go to the background.
  window.drivehuntBack = function () {
    if (window.ActionBar?.visible) return document.querySelector('#action-bar .ab-cancel').click(), true;
    if (window.Measure?.active) return document.querySelector('.measure-panel [data-act=close]')?.click(), true;
    if (typeof state === 'undefined' || !state.me) return false;
    if (state.view === 'edit') return $('edit-cancel').click(), true;
    if (state.view === 'fields') return $('fields-back').click(), true;
    if (state.view === 'focus') return showList(), true;
    return false;
  };
})();
