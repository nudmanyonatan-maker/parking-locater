/* global maplibregl */
// Default home near YU / Audubon Ave (between W 185th & W 186th). Best-guess
// starting point — the user fixes it exactly with the 🏠 "set home" button.
const DEFAULT_HOME = { lat: 40.8512, lng: -73.9293 };

const els = {
  parkView: document.getElementById("park-view"),
  findView: document.getElementById("find-view"),
  parkBtn: document.getElementById("park-btn"),
  distance: document.getElementById("distance"),
  fromHome: document.getElementById("from-home"),
  movebyBanner: document.getElementById("moveby-banner"),
  walkBtn: document.getElementById("walk-btn"),
  editBtn: document.getElementById("edit-btn"),
  clearBtn: document.getElementById("clear-btn"),
  editForm: document.getElementById("edit-form"),
  noteInput: document.getElementById("note-input"),
  movebyInput: document.getElementById("moveby-input"),
  saveEditBtn: document.getElementById("save-edit-btn"),
  sethomeBtn: document.getElementById("sethome-btn"),
  fitBtn: document.getElementById("fit-btn"),
  error: document.getElementById("error"),
  placemapBtn: document.getElementById("placemap-btn"),
  moveBtn: document.getElementById("move-btn"),
  placeView: document.getElementById("place-view"),
  placeSave: document.getElementById("place-save"),
  placeCancel: document.getElementById("place-cancel"),
  crosshair: document.getElementById("crosshair"),
};

let map = null;
let mapReady = false;
let geolocate = null;
let carMarker = null;
let homeMarker = null;
let spot = null;       // current saved spot {lat,lng,note,moveBy,...} or null
let lastMe = null;     // {lat,lng} of the user, from the geolocate control

const lngLatOf = (o) => [o.lng, o.lat];

// ---- Home (stored on this device) ----
function getHome() {
  try {
    const h = JSON.parse(localStorage.getItem("home"));
    if (h && Number.isFinite(h.lat) && Number.isFinite(h.lng)) return h;
  } catch (e) { /* fall through */ }
  return DEFAULT_HOME;
}
function setHomeLocal(latlng) {
  localStorage.setItem("home", JSON.stringify(latlng));
}

function showError(msg) {
  els.error.textContent = msg;
  els.error.classList.remove("hidden");
}
function clearError() {
  els.error.classList.add("hidden");
}

function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function formatDistance(m) {
  const feet = m * 3.28084;
  if (feet < 1000) return `${Math.round(feet)} ft`;
  return `${(m / 1609.34).toFixed(1)} mi`;
}

function pinEl(className, text) {
  const el = document.createElement("div");
  el.className = className;
  el.textContent = text;
  return el;
}

// ---- API ----
async function fetchSpot() {
  const res = await fetch("/api/spot");
  return res.json();
}
async function saveSpot(s) {
  const res = await fetch("/api/spot", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lat: s.lat, lng: s.lng, note: s.note || "", moveBy: s.moveBy ?? null }),
  });
  if (!res.ok) throw new Error("save failed");
  return res.json();
}

// ---- Map ----
function styleUrl() {
  const dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  return `https://tiles.openfreemap.org/styles/${dark ? "dark" : "liberty"}`;
}

function initMap(center) {
  map = new maplibregl.Map({
    container: "map",
    style: styleUrl(),
    center: lngLatOf(center),
    zoom: 15,
    attributionControl: { compact: true },
  });
  window.__map = map; // exposed for debugging

  map.addControl(new maplibregl.NavigationControl({ showZoom: false, showCompass: true, visualizePitch: true }), "top-right");

  geolocate = new maplibregl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    trackUserLocation: true,
    showUserHeading: true,
  });
  map.addControl(geolocate, "top-right");
  geolocate.on("geolocate", (e) => {
    lastMe = { lat: e.coords.latitude, lng: e.coords.longitude };
    updateDistances();
  });

  map.on("load", () => {
    mapReady = true;
    map.addSource("route", { type: "geojson", data: routeData() });
    map.addLayer({
      id: "route",
      type: "line",
      source: "route",
      layout: { "line-cap": "round" },
      paint: { "line-color": "#16a34a", "line-width": 5, "line-opacity": 0.9, "line-dasharray": [0.4, 2] },
    });
    setupPois();
    placeHome();
    if (spot) {
      placeCar();
      frameAll();
    }
    // Show the user immediately (native blue dot + heading).
    try { geolocate.trigger(); } catch (e) { /* user can tap the button */ }
  });
}

function routeData() {
  if (!spot) return { type: "FeatureCollection", features: [] };
  const h = getHome();
  return { type: "Feature", geometry: { type: "LineString", coordinates: [[h.lng, h.lat], [spot.lng, spot.lat]] } };
}
function drawLine() {
  const src = map.getSource("route");
  if (src) src.setData(routeData());
}

// Emoji icon for each POI category (Dunkin'=fast_food/cafe, bodega=convenience, YU=college, etc.)
const POI_EMOJI = {
  cafe: "☕", fast_food: "🍔", restaurant: "🍴", bar: "🍺", pub: "🍺",
  convenience: "🏪", grocery: "🛒", supermarket: "🛒", greengrocer: "🥬", bakery: "🥐",
  shop: "🛍️", clothing_store: "👕", department_store: "🏬", marketplace: "🛒",
  parking: "🅿️", fuel: "⛽", bank: "🏦", atm: "🏧", pharmacy: "💊", hospital: "🏥",
  college: "🎓", university: "🎓", school: "🏫", library: "📚",
  place_of_worship: "🕍", post: "📮", police: "🚓", fire_station: "🚒", laundry: "🧺",
  hairdresser: "💈", car: "🚙", car_repair: "🔧", hardware: "🛠️", books: "📚",
};

// Render an emoji into a small canvas → ImageData for map.addImage.
function emojiImage(emoji) {
  const size = 44;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d");
  ctx.font = '34px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(emoji, size / 2, size / 2);
  return ctx.getImageData(0, 0, size, size);
}

// Add a custom POI layer with emoji icons + names, surfaced from a normal zoom.
function setupPois() {
  // Hide the base style's own POI labels so we don't double them up.
  ["poi_r1", "poi_r7", "poi_r20"].forEach((id) => {
    if (map.getLayer(id)) { try { map.setLayoutProperty(id, "visibility", "none"); } catch (e) { /* ignore */ } }
  });

  Object.entries(POI_EMOJI).forEach(([cls, emoji]) => {
    const id = "poi-" + cls;
    if (!map.hasImage(id)) { try { map.addImage(id, emojiImage(emoji), { pixelRatio: 2 }); } catch (e) { /* ignore */ } }
  });
  if (!map.hasImage("poi-generic")) map.addImage("poi-generic", emojiImage("📍"), { pixelRatio: 2 });

  const dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;

  map.addLayer({
    id: "poi-emoji",
    type: "symbol",
    source: "openmaptiles",
    "source-layer": "poi",
    minzoom: 14,
    filter: ["all",
      ["match", ["geometry-type"], ["Point", "MultiPoint"], true, false],
      ["!", ["match", ["get", "class"],
        ["bus", "rail", "airport", "ferry_terminal", "bicycle_rental", "entrance", "pitch"], true, false]],
      ["has", "name"],
    ],
    layout: {
      "icon-image": ["coalesce", ["image", ["concat", "poi-", ["get", "class"]]], ["image", "poi-generic"]],
      "icon-size": 0.9,
      "icon-allow-overlap": false,
      "text-field": ["get", "name"],
      "text-font": ["Noto Sans Bold"],
      "text-size": 11,
      "text-anchor": "top",
      "text-offset": [0, 0.7],
      "text-optional": true,
      "text-max-width": 9,
      "symbol-sort-key": ["to-number", ["coalesce", ["get", "rank"], 100]],
    },
    paint: {
      "text-color": dark ? "#e5e7eb" : "#111827",
      "text-halo-color": dark ? "#000000" : "#ffffff",
      "text-halo-width": 1.4,
    },
  });
}

function placeHome() {
  if (homeMarker) homeMarker.remove();
  homeMarker = new maplibregl.Marker({ element: pinEl("pin pin-home", "🏠") })
    .setLngLat(lngLatOf(getHome()))
    .addTo(map);
}

function placeCar() {
  if (carMarker) carMarker.remove();
  carMarker = new maplibregl.Marker({ element: pinEl("pin pin-car", "🚗"), draggable: true })
    .setLngLat([spot.lng, spot.lat])
    .addTo(map);
  if (spot.note) {
    carMarker.setPopup(new maplibregl.Popup({ offset: 30, closeButton: false }).setText(spot.note));
  }
  carMarker.on("dragend", async () => {
    const ll = carMarker.getLngLat();
    spot.lat = ll.lat;
    spot.lng = ll.lng;
    drawLine();
    updateDistances();
    updateWalkLink();
    try { spot = await saveSpot(spot); } catch (e) { showError("Couldn't save the new spot."); }
  });
}

function frameAll() {
  const pts = [getHome()];
  if (spot) pts.push({ lat: spot.lat, lng: spot.lng });
  if (lastMe) pts.push(lastMe);
  if (pts.length === 1) { map.easeTo({ center: lngLatOf(pts[0]), zoom: 16 }); return; }
  const b = new maplibregl.LngLatBounds();
  pts.forEach((p) => b.extend(lngLatOf(p)));
  map.fitBounds(b, { padding: { top: 90, bottom: 280, left: 60, right: 60 }, maxZoom: 17, duration: 600 });
}

function updateDistances() {
  if (!spot) { els.fromHome.classList.add("hidden"); return; }
  const car = { lat: spot.lat, lng: spot.lng };
  els.fromHome.textContent = `🏠 ${formatDistance(haversineMeters(getHome(), car))} from home`;
  els.fromHome.classList.remove("hidden");
  els.distance.textContent = lastMe
    ? `${formatDistance(haversineMeters(lastMe, car))} away`
    : "Locating you…";
}

function updateWalkLink() {
  els.walkBtn.href = `https://maps.apple.com/?daddr=${spot.lat},${spot.lng}&dirflg=w`;
}

function renderMoveByBanner() {
  const moveBy = spot && spot.moveBy;
  if (!moveBy) { els.movebyBanner.classList.add("hidden"); return; }
  const when = new Date(moveBy).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" });
  const msLeft = moveBy - Date.now();
  els.movebyBanner.classList.remove("hidden");
  if (msLeft < 0) {
    els.movebyBanner.textContent = `⚠️ Move-by time passed (${when})`;
    els.movebyBanner.classList.add("urgent");
  } else {
    els.movebyBanner.textContent = `Move by ${when}`;
    els.movebyBanner.classList.toggle("urgent", msLeft <= 30 * 60 * 1000);
  }
}

// ---- Panels ----
function showParkPanel() {
  els.findView.classList.add("hidden");
  els.placeView.classList.add("hidden");
  els.crosshair.classList.add("hidden");
  els.fitBtn.classList.add("hidden");
  els.sethomeBtn.classList.remove("hidden");
  els.parkView.classList.remove("hidden");
  els.parkBtn.textContent = "📍 I parked here";
  els.editForm.classList.add("hidden");
}

function showFindPanel() {
  els.parkView.classList.add("hidden");
  els.placeView.classList.add("hidden");
  els.crosshair.classList.add("hidden");
  els.findView.classList.remove("hidden");
  els.fitBtn.classList.remove("hidden");
  els.sethomeBtn.classList.remove("hidden");
  els.editForm.classList.add("hidden");
  updateWalkLink();
  updateDistances();
  renderMoveByBanner();
  els.noteInput.value = spot.note || "";
  els.movebyInput.value = spot.moveBy ? toLocalInput(spot.moveBy) : "";
}

function toLocalInput(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---- Actions ----
els.parkBtn.addEventListener("click", () => {
  clearError();
  els.parkBtn.textContent = "Saving…";
  navigator.geolocation.getCurrentPosition(
    async (pos) => { await commitPark(pos.coords.latitude, pos.coords.longitude, false); },
    async () => {
      // No GPS: drop at map center, save, let them drag.
      const c = map.getCenter();
      showError("No GPS — drag the 🚗 to where you parked.");
      await commitPark(c.lat, c.lng, true);
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
});

async function commitPark(lat, lng, manual) {
  try {
    spot = await saveSpot({ lat, lng, note: "", moveBy: null });
    showFindPanel();
    if (mapReady) {
      placeCar();
      drawLine();
      if (manual) { map.easeTo({ center: [lng, lat], zoom: 18 }); }
      else { frameAll(); }
      try { geolocate.trigger(); } catch (e) { /* ignore */ }
    }
  } catch (e) {
    els.parkBtn.textContent = "📍 I parked here";
    showError("Couldn't save. Check your connection and try again.");
  }
}

els.clearBtn.addEventListener("click", async () => {
  clearError();
  try { await fetch("/api/spot", { method: "DELETE" }); } catch (e) { /* ignore */ }
  spot = null;
  if (carMarker) { carMarker.remove(); carMarker = null; }
  if (mapReady) { drawLine(); map.easeTo({ center: lngLatOf(getHome()), zoom: 16 }); }
  showParkPanel();
});

els.editBtn.addEventListener("click", () => {
  els.editForm.classList.toggle("hidden");
});

els.saveEditBtn.addEventListener("click", async () => {
  clearError();
  els.saveEditBtn.textContent = "Saving…";
  spot.note = els.noteInput.value.trim();
  spot.moveBy = els.movebyInput.value ? new Date(els.movebyInput.value).getTime() : null;
  try {
    spot = await saveSpot(spot);
    placeCar();           // refresh popup with new note
    renderMoveByBanner();
    els.editForm.classList.add("hidden");
  } catch (e) {
    showError("Couldn't save the note/time.");
  } finally {
    els.saveEditBtn.textContent = "Save";
  }
});

els.fitBtn.addEventListener("click", frameAll);

els.sethomeBtn.addEventListener("click", () => {
  if (!confirm("Set your home to your current location? (do this at your building)")) return;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      setHomeLocal({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      if (mapReady) { placeHome(); drawLine(); updateDistances(); frameAll(); }
    },
    () => showError("Couldn't get GPS to set home. Try again outside."),
    { enableHighAccuracy: true, timeout: 10000 }
  );
});

// ---- Placing mode (drag the map under the center crosshair) ----
let placingMode = null; // 'new' | 'move'

function setCarMarkerVisible(visible) {
  if (carMarker) carMarker.getElement().style.display = visible ? "" : "none";
}

function enterPlacing(mode) {
  if (!mapReady) return;
  clearError();
  placingMode = mode;
  if (mode === "move" && spot) {
    map.easeTo({ center: [spot.lng, spot.lat], zoom: Math.max(map.getZoom(), 17) });
  } else if (map.getZoom() < 15) {
    map.easeTo({ zoom: 16 });
  }
  setCarMarkerVisible(false);
  els.parkView.classList.add("hidden");
  els.findView.classList.add("hidden");
  els.placeView.classList.remove("hidden");
  els.crosshair.classList.remove("hidden");
  els.sethomeBtn.classList.add("hidden");
  els.fitBtn.classList.add("hidden");
}

async function confirmPlacing() {
  const c = map.getCenter();
  const note = spot ? spot.note || "" : "";
  const moveBy = spot ? spot.moveBy ?? null : null;
  els.placeSave.textContent = "Saving…";
  try {
    spot = await saveSpot({ lat: c.lat, lng: c.lng, note, moveBy });
    placeCar();
    setCarMarkerVisible(true);
    drawLine();
    showFindPanel();
    frameAll();
  } catch (e) {
    showError("Couldn't save the spot. Try again.");
  } finally {
    els.placeSave.textContent = "✓ Save here";
  }
}

function cancelPlacing() {
  if (spot) { setCarMarkerVisible(true); showFindPanel(); }
  else { showParkPanel(); }
}

els.placemapBtn.addEventListener("click", () => enterPlacing("new"));
els.moveBtn.addEventListener("click", () => enterPlacing("move"));
els.placeSave.addEventListener("click", confirmPlacing);
els.placeCancel.addEventListener("click", cancelPlacing);

// ---- Boot ----
async function boot() {
  let initial = getHome();
  try {
    const s = await fetchSpot();
    if (s && Number.isFinite(s.lat)) { spot = s; initial = { lat: s.lat, lng: s.lng }; }
  } catch (e) { /* offline: start at home */ }
  if (spot) showFindPanel(); else showParkPanel();
  initMap(initial);
}
boot();
