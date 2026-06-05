/* global L */
const HOME = [40.8506, -73.9300]; // 184th & Audubon fallback center

const els = {
  parkView: document.getElementById("park-view"),
  findView: document.getElementById("find-view"),
  parkBtn: document.getElementById("park-btn"),
  parkForm: document.getElementById("park-form"),
  noteInput: document.getElementById("note-input"),
  movebyInput: document.getElementById("moveby-input"),
  saveBtn: document.getElementById("save-btn"),
  distance: document.getElementById("distance"),
  movebyBanner: document.getElementById("moveby-banner"),
  noteDisplay: document.getElementById("note-display"),
  walkBtn: document.getElementById("walk-btn"),
  clearBtn: document.getElementById("clear-btn"),
  recenterBtn: document.getElementById("recenter-btn"),
  error: document.getElementById("error"),
};

const map = L.map("map", { zoomControl: false }).setView(HOME, 16);

// Clean, familiar street map (free, no API key). Retina-crisp via {r}.
L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
  attribution: "&copy; OpenStreetMap &copy; CARTO",
  subdomains: "abcd",
  maxZoom: 20,
}).addTo(map);

// Big obvious car pin and a blue "you are here" dot.
const carIcon = L.divIcon({ className: "pin pin-car", html: "🚗", iconSize: [52, 52], iconAnchor: [26, 26] });
const youIcon = L.divIcon({ className: "pin pin-you", html: "", iconSize: [22, 22], iconAnchor: [11, 11] });

let carMarker = null; // the parked-car pin
let meMarker = null;  // user's live location dot
let line = null;      // line connecting you -> car
let pending = null;   // {lat,lng} being placed before save
let carLatLng = null; // saved car location in find view
let lastMe = null;    // last known user location
let framedOnce = false; // have we auto-zoomed to fit yet?
let watchId = null;   // geolocation watch handle

function showError(msg) {
  els.error.textContent = msg;
  els.error.classList.remove("hidden");
}
function clearError() {
  els.error.classList.add("hidden");
}

function setCarMarker(lat, lng, draggable) {
  if (carMarker) map.removeLayer(carMarker);
  carMarker = L.marker([lat, lng], { icon: carIcon, draggable }).addTo(map);
  if (draggable) {
    carMarker.on("dragend", () => {
      const p = carMarker.getLatLng();
      pending = { lat: p.lat, lng: p.lng };
    });
  }
}

function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function formatDistance(m) {
  const feet = m * 3.28084;
  if (feet < 1000) return `${Math.round(feet)} ft away`;
  return `${(m / 1609.34).toFixed(1)} mi away`;
}

function frameBoth() {
  if (lastMe && carLatLng) {
    map.fitBounds(L.latLngBounds([lastMe, carLatLng]).pad(0.35), { maxZoom: 18 });
  } else if (carLatLng) {
    map.setView(carLatLng, 17);
  }
}

// ---- State A: parking ----
els.parkBtn.addEventListener("click", () => {
  clearError();
  els.parkBtn.textContent = "Locating…";
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude } = pos.coords;
      pending = { lat: latitude, lng: longitude };
      map.setView([latitude, longitude], 18);
      setCarMarker(latitude, longitude, true);
      els.parkBtn.classList.add("hidden");
      els.parkForm.classList.remove("hidden");
    },
    () => {
      // GPS denied/unavailable: drop a draggable pin they can position by hand.
      showError("Couldn't get GPS — drag the 🚗 to where you parked.");
      pending = { lat: HOME[0], lng: HOME[1] };
      map.setView(HOME, 17);
      setCarMarker(HOME[0], HOME[1], true);
      els.parkBtn.classList.add("hidden");
      els.parkForm.classList.remove("hidden");
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
});

els.saveBtn.addEventListener("click", async () => {
  if (!pending) return;
  clearError();
  els.saveBtn.textContent = "Saving…";
  const moveBy = els.movebyInput.value
    ? new Date(els.movebyInput.value).getTime()
    : null;
  try {
    const res = await fetch("/api/spot", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lat: pending.lat,
        lng: pending.lng,
        note: els.noteInput.value.trim(),
        moveBy,
      }),
    });
    if (!res.ok) throw new Error("save failed");
    const spot = await res.json();
    renderFindView(spot);
  } catch (err) {
    els.saveBtn.textContent = "Save spot";
    showError("Couldn't save. Check your connection and try again.");
  }
});

// ---- State B: find ----
els.clearBtn.addEventListener("click", async () => {
  clearError();
  try {
    await fetch("/api/spot", { method: "DELETE" });
  } catch (err) {
    // Return to the parking view even if the network call failed.
  }
  renderParkView();
});

els.recenterBtn.addEventListener("click", frameBoth);

function renderParkView() {
  if (carMarker) { map.removeLayer(carMarker); carMarker = null; }
  if (meMarker) { map.removeLayer(meMarker); meMarker = null; }
  if (line) { map.removeLayer(line); line = null; }
  if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  pending = null;
  carLatLng = null;
  lastMe = null;
  framedOnce = false;
  els.findView.classList.add("hidden");
  els.recenterBtn.classList.add("hidden");
  els.parkView.classList.remove("hidden");
  els.parkForm.classList.add("hidden");
  els.parkBtn.classList.remove("hidden");
  els.parkBtn.textContent = "📍 I parked here";
  els.noteInput.value = "";
  els.movebyInput.value = "";
}

function renderFindView(spot) {
  els.parkView.classList.add("hidden");
  els.saveBtn.textContent = "Save spot";
  els.findView.classList.remove("hidden");
  els.recenterBtn.classList.remove("hidden");

  carLatLng = [spot.lat, spot.lng];
  framedOnce = false;
  setCarMarker(spot.lat, spot.lng, false);
  map.setView(carLatLng, 17);

  els.walkBtn.href = `https://maps.apple.com/?daddr=${spot.lat},${spot.lng}&dirflg=w`;

  if (spot.note) {
    els.noteDisplay.textContent = spot.note;
    els.noteDisplay.classList.remove("hidden");
  } else {
    els.noteDisplay.classList.add("hidden");
  }

  renderMoveByBanner(spot.moveBy);

  els.distance.textContent = "Locating you…";
  watchMyLocation();
}

function renderMoveByBanner(moveBy) {
  if (!moveBy) { els.movebyBanner.classList.add("hidden"); return; }
  const when = new Date(moveBy).toLocaleString("en-US", {
    weekday: "short", hour: "numeric", minute: "2-digit",
  });
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

function watchMyLocation() {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      lastMe = [pos.coords.latitude, pos.coords.longitude];

      if (meMarker) map.removeLayer(meMarker);
      meMarker = L.marker(lastMe, { icon: youIcon, interactive: false }).addTo(map);

      if (line) map.removeLayer(line);
      line = L.polyline([lastMe, carLatLng], {
        color: "#16a34a", weight: 6, opacity: 0.8, dashArray: "2 12", lineCap: "round",
      }).addTo(map);

      const meters = haversineMeters(lastMe, carLatLng);
      els.distance.textContent = formatDistance(meters);

      if (!framedOnce) { frameBoth(); framedOnce = true; }
    },
    () => { els.distance.textContent = "Tap 🧭 for directions"; },
    { enableHighAccuracy: true }
  );
}

// ---- Boot: decide which state to show ----
async function boot() {
  try {
    const res = await fetch("/api/spot");
    const spot = await res.json();
    if (spot && Number.isFinite(spot.lat)) {
      renderFindView(spot);
    } else {
      renderParkView();
    }
  } catch (err) {
    renderParkView();
  }
}
boot();
