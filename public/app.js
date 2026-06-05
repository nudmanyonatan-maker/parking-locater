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
  error: document.getElementById("error"),
};

const map = L.map("map", { zoomControl: false }).setView(HOME, 16);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "© OpenStreetMap",
  maxZoom: 19,
}).addTo(map);

let carMarker = null; // the parked-car pin
let meMarker = null;  // user's live location dot
let pending = null;   // {lat,lng} being placed before save
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
  carMarker = L.marker([lat, lng], { draggable }).addTo(map);
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
      showError("Couldn't get GPS — drag the pin to where you parked.");
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

function renderParkView() {
  if (carMarker) { map.removeLayer(carMarker); carMarker = null; }
  if (meMarker) { map.removeLayer(meMarker); meMarker = null; }
  if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  pending = null;
  els.findView.classList.add("hidden");
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

  setCarMarker(spot.lat, spot.lng, false);
  map.setView([spot.lat, spot.lng], 18);

  els.walkBtn.href = `https://maps.apple.com/?daddr=${spot.lat},${spot.lng}&dirflg=w`;

  if (spot.note) {
    els.noteDisplay.textContent = spot.note;
    els.noteDisplay.classList.remove("hidden");
  } else {
    els.noteDisplay.classList.add("hidden");
  }

  renderMoveByBanner(spot.moveBy);

  els.distance.textContent = "Locating you…";
  watchMyLocation(spot);
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

function watchMyLocation(spot) {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const me = [pos.coords.latitude, pos.coords.longitude];
      if (meMarker) map.removeLayer(meMarker);
      meMarker = L.circleMarker(me, { radius: 8, color: "#2563eb" }).addTo(map);
      const meters = haversineMeters(me, [spot.lat, spot.lng]);
      els.distance.textContent = formatDistance(meters);
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
