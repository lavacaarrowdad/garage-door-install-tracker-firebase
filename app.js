import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getAuth,
  browserLocalPersistence,
  setPersistence,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  getFirestore,
  collection,
  addDoc,
  doc,
  updateDoc,
  deleteDoc,
  getDocs,
  query,
  where,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCjThqEPXthrR7Y03lkgJcKlulGeKzaJzc",
  authDomain: "garage-door-install-tracker.firebaseapp.com",
  projectId: "garage-door-install-tracker",
  storageBucket: "garage-door-install-tracker.firebasestorage.app",
  messagingSenderId: "262720963752",
  appId: "1:262720963752:web:b0534a16d76ef9b0d2ae9d"
};

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);

let currentUser = null;
let records = [];
let editingId = null;
let map = null;
let markerLayer = null;
let pinPickerMap = null;
let pinPickerMarker = null;
let pinPickerRecordId = null;
const geocodeAttempted = new Set();

const el = (id) => document.getElementById(id);
const fields = [
  "customer_name", "address_line1", "city", "state", "postal_code",
  "install_date", "manufacturer", "model_number", "door_size",
  "spring_size", "door_type", "color", "lift_type", "spring_count", "notes"
];
const extraDoorFields = [
  "manufacturer", "model_number", "door_size", "spring_size",
  "door_type", "color", "lift_type", "spring_count"
];

document.addEventListener("DOMContentLoaded", init);

async function init() {
  bindEvents();

  try {
    await setPersistence(auth, browserLocalPersistence);
  } catch (error) {
    console.warn("Could not set auth persistence:", error);
  }

  onAuthStateChanged(auth, async (user) => {
    currentUser = user;
    await syncAuthView();
  });
}

function bindEvents() {
  el("authForm").addEventListener("submit", signIn);
  el("signOutBtn").addEventListener("click", async () => {
    try {
      await signOut(auth);
    } catch (error) {
      showToast("Could not sign out: " + friendlyError(error), true);
    }
  });

  el("addBtn").addEventListener("click", () => openRecordDialog());
  el("addExtraDoorBtn").addEventListener("click", () => addExtraDoorCard());

  el("searchForm").addEventListener("submit", (event) => {
    event.preventDefault();
    renderRecords();
    renderMapMarkers();
  });

  el("searchInput").addEventListener("input", () => {
    renderRecords();
    renderMapMarkers();
  });

  el("clearSearchBtn").addEventListener("click", () => {
    el("searchInput").value = "";
    renderRecords();
    renderMapMarkers();
    el("searchInput").focus();
  });

  el("mapToggleBtn").addEventListener("click", toggleMap);
  el("retryPinsBtn").addEventListener("click", retryMapPins);
  el("exportBtn").addEventListener("click", exportCsv);
  el("closePinDialogBtn").addEventListener("click", closePinPicker);
  el("cancelPinBtn").addEventListener("click", closePinPicker);
  el("savePinBtn").addEventListener("click", savePinPicker);
  el("openAddressBtn").addEventListener("click", () => {
    const record = records.find((item) => item.id === pinPickerRecordId);
    if (!record) return;
    window.open(
      "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(fullAddress(record)),
      "_blank",
      "noopener"
    );
  });
  el("recordForm").addEventListener("submit", saveRecord);
  el("closeDialogBtn").addEventListener("click", closeRecordDialog);
  el("cancelBtn").addEventListener("click", closeRecordDialog);

  el("recordDialog").addEventListener("click", (event) => {
    if (event.target === el("recordDialog")) closeRecordDialog();
  });
}

async function syncAuthView() {
  const signedIn = !!currentUser;
  el("authView").classList.toggle("hidden", signedIn);
  el("appView").classList.toggle("hidden", !signedIn);
  el("userArea").classList.toggle("hidden", !signedIn);

  if (signedIn) {
    el("userEmail").textContent = currentUser.email || "";
    await loadRecords();
  } else {
    records = [];
    el("recordsList").innerHTML = "";
    el("recordCount").textContent = "0";
  }
}

async function signIn(event) {
  event.preventDefault();

  const email = el("email").value.trim();
  const password = el("password").value;
  const button = el("signInBtn");

  if (!email || !password) {
    setAuthMessage("Enter your email and password.", true);
    return;
  }

  button.disabled = true;
  button.textContent = "Signing in...";
  setAuthMessage("");

  try {
    await signInWithEmailAndPassword(auth, email, password);
  } catch (error) {
    console.error("Firebase sign-in failed:", error);
    const code = String(error?.code || "");
    if (code.includes("invalid-credential") || code.includes("wrong-password") || code.includes("user-not-found")) {
      setAuthMessage("Email or password not recognized.", true);
    } else if (code.includes("too-many-requests")) {
      setAuthMessage("Too many attempts. Wait a little while and try again.", true);
    } else if (code.includes("network-request-failed")) {
      setAuthMessage("Could not reach Firebase. Check your internet connection and try again.", true);
    } else {
      setAuthMessage("Sign-in failed: " + friendlyError(error), true);
    }
  } finally {
    button.disabled = false;
    button.textContent = "Sign in";
  }
}

function setAuthMessage(message, isError = false) {
  el("authMessage").textContent = message || "";
  el("authMessage").style.color = isError ? "#fecdd3" : "";
}

async function loadRecords() {
  if (!currentUser) return;

  try {
    const q = query(
      collection(db, "installations"),
      where("userId", "==", currentUser.uid)
    );

    const snapshot = await getDocs(q);
    records = snapshot.docs.map((snap) => ({ id: snap.id, ...snap.data() }));

    records.sort((a, b) => {
      const dateCompare = String(b.install_date || "").localeCompare(String(a.install_date || ""));
      if (dateCompare !== 0) return dateCompare;
      const bTime = b.createdAt?.seconds || 0;
      const aTime = a.createdAt?.seconds || 0;
      return bTime - aTime;
    });

    renderRecords();
    ensureMap();
    renderMapMarkers();
    void backfillMissingCoordinates();
  } catch (error) {
    console.error("Load failed:", error);
    showToast("Could not load installations: " + friendlyError(error), true);
  }
}

function getFilteredRecords() {
  const queryText = el("searchInput").value.trim().toLowerCase();
  if (!queryText) return records;

  const terms = queryText.split(/\s+/).filter(Boolean);

  return records.filter((record) => {
    const haystack = [
      record.customer_name,
      record.address_line1,
      record.city,
      record.state,
      record.postal_code,
      record.manufacturer,
      record.model_number,
      record.door_size,
      record.spring_size,
      record.spring_count,
      record.door_type,
      record.color,
      record.lift_type,
      record.install_date,
      formatDate(record.install_date),
      record.notes,
      JSON.stringify(record.extraDoors || [])
    ].map((value) => String(value || "").toLowerCase()).join(" ");

    return terms.every((term) => haystack.includes(term));
  });
}

function renderRecords() {
  const queryText = el("searchInput").value.trim();
  const filtered = getFilteredRecords();

  el("recordCount").textContent = records.length;
  el("filterCount").textContent = queryText ? filtered.length + " matching" : "";
  el("emptyState").classList.toggle("hidden", records.length !== 0);

  if (!filtered.length) {
    el("recordsList").innerHTML = records.length
      ? '<div class="empty-state"><h3>No matches</h3><p>Try a different search.</p></div>'
      : "";
    return;
  }

  el("recordsList").innerHTML = filtered.map(recordCardHtml).join("");

  document.querySelectorAll("[data-edit]").forEach((button) => {
    button.addEventListener("click", () => openRecordDialog(button.dataset.edit));
  });
  document.querySelectorAll("[data-delete]").forEach((button) => {
    button.addEventListener("click", () => deleteRecord(button.dataset.delete));
  });
  document.querySelectorAll("[data-map]").forEach((button) => {
    button.addEventListener("click", () => focusRecordOnMap(button.dataset.map));
  });
}

function recordCardHtml(record) {
  const address = fullAddress(record);
  const extraDoors = Array.isArray(record.extraDoors) ? record.extraDoors : [];
  const details = [
    ["Model", joinParts(record.manufacturer, record.model_number)],
    ["Door size", record.door_size],
    ["Spring", record.spring_size],
    ["Type", record.door_type],
    ["Color", record.color],
    ["Lift", record.lift_type]
  ].filter((item) => item[1]);

  return '<article class="record-card">' +
    '<div class="record-top"><div>' +
      (record.customer_name ? '<div class="eyebrow">' + esc(record.customer_name) + '</div>' : '') +
      '<div class="record-address">' + esc(address || "No address") + '</div>' +
    '</div><div class="record-date">' + esc(formatDate(record.install_date)) + '</div></div>' +
    '<div class="record-details">' +
      details.map((item) => '<div class="detail"><span>' + esc(item[0]) + '</span><strong>' + esc(item[1]) + '</strong></div>').join("") +
    '</div>' +
    (extraDoors.length
      ? '<div class="extra-door-summary-list">' +
        extraDoors.map((door, index) =>
          '<div class="extra-door-summary"><strong>Door ' + (index + 2) + '</strong><span>' +
          esc(extraDoorSummary(door)) + '</span></div>'
        ).join("") +
        '</div>'
      : '') +
    (record.notes ? '<p class="muted">' + esc(record.notes) + '</p>' : '') +
    '<div class="record-actions">' +
      '<button class="button secondary small" data-edit="' + esc(record.id) + '">Edit</button>' +
      '<button class="button secondary small" data-map="' + esc(record.id) + '">' +
        (record.latitude != null && record.longitude != null ? "Map" : "Set pin") +
      '</button>' +
      '<button class="button danger small" data-delete="' + esc(record.id) + '">Delete</button>' +
    '</div>' +
  '</article>';
}

function extraDoorSummary(door) {
  const parts = [
    joinParts(door.manufacturer, door.model_number),
    door.door_size,
    door.spring_size ? "Spring " + door.spring_size : "",
    door.door_type,
    door.color,
    door.lift_type
  ].filter(Boolean);
  return parts.join(" • ") || "Additional door";
}

function addExtraDoorCard(door = {}) {
  const container = el("extraDoorsContainer");
  const card = document.createElement("div");
  card.className = "extra-door-card";
  card.innerHTML =
    '<div class="extra-door-card-header">' +
      '<strong>Additional door</strong>' +
      '<button class="button danger small remove-extra-door" type="button">Remove</button>' +
    '</div>' +
    '<div class="extra-door-grid">' +
      '<label>Manufacturer<input data-door-field="manufacturer" placeholder="Clopay, Wayne Dalton..."></label>' +
      '<label>Model #<input data-door-field="model_number"></label>' +
      '<label>Door size<input data-door-field="door_size" placeholder="16 x 7"></label>' +
      '<label>Spring size<input data-door-field="spring_size" placeholder=".250 x 2 x 31"></label>' +
      '<label>Door type<input data-door-field="door_type" list="doorTypes" placeholder="Raised panel"></label>' +
      '<label>Color<input data-door-field="color" list="colors" placeholder="White"></label>' +
      '<label>Lift<input data-door-field="lift_type" list="liftTypes" placeholder="Standard lift"></label>' +
      '<label>Number of springs<input data-door-field="spring_count" type="number" min="0" step="1"></label>' +
    '</div>';

  extraDoorFields.forEach((name) => {
    const input = card.querySelector('[data-door-field="' + name + '"]');
    const value = door[name];
    input.value = value == null ? "" : value;
  });

  card.querySelector(".remove-extra-door").addEventListener("click", () => {
    card.remove();
    renumberExtraDoors();
  });

  container.appendChild(card);
  renumberExtraDoors();
}

function renumberExtraDoors() {
  el("extraDoorsContainer").querySelectorAll(".extra-door-card").forEach((card, index) => {
    const title = card.querySelector(".extra-door-card-header strong");
    if (title) title.textContent = "Door " + (index + 2);
  });
}

function renderExtraDoors(doors) {
  el("extraDoorsContainer").innerHTML = "";
  if (!Array.isArray(doors)) return;
  doors.forEach((door) => addExtraDoorCard(door));
}

function collectExtraDoors() {
  return Array.from(el("extraDoorsContainer").querySelectorAll(".extra-door-card"))
    .map((card) => {
      const door = {};
      extraDoorFields.forEach((name) => {
        const input = card.querySelector('[data-door-field="' + name + '"]');
        let value = input.value.trim();
        if (name === "spring_count") value = value === "" ? null : Number(value);
        door[name] = value === "" ? null : value;
      });
      return door;
    })
    .filter((door) => extraDoorFields.some((name) => door[name] !== null && door[name] !== ""));
}

function openRecordDialog(id) {
  editingId = id || null;
  el("recordForm").reset();
  el("extraDoorsContainer").innerHTML = "";

  if (editingId) {
    const record = records.find((item) => item.id === editingId);
    if (!record) return;

    el("dialogTitle").textContent = "Edit installation";
    fields.forEach((name) => {
      el(name).value = record[name] ?? "";
    });
    renderExtraDoors(record.extraDoors || []);
  } else {
    el("dialogTitle").textContent = "Add installation";
  }

  el("recordDialog").showModal();
}

function closeRecordDialog() {
  editingId = null;
  el("recordDialog").close();
}

async function saveRecord(event) {
  event.preventDefault();
  if (!currentUser) return;

  const wasEditing = !!editingId;
  const existing = wasEditing ? records.find((item) => item.id === editingId) : null;
  const payload = {
    userId: currentUser.uid,
    extraDoors: collectExtraDoors()
  };

  fields.forEach((name) => {
    let value = el(name).value.trim();
    if (name === "spring_count") value = value === "" ? null : Number(value);
    payload[name] = value === "" ? null : value;
  });

  if (!payload.address_line1 || !payload.city || !payload.state) {
    showToast("Address, city and state are required.", true);
    return;
  }

  const button = el("saveBtn");
  button.disabled = true;
  button.textContent = "Saving...";

  try {
    const addressChanged = !existing ||
      fullAddress(existing).toLowerCase() !== fullAddress(payload).toLowerCase();

    if (addressChanged || existing?.latitude == null || existing?.longitude == null) {
      const coords = await geocodeRecord(payload);
      payload.latitude = coords?.lat ?? null;
      payload.longitude = coords?.lng ?? null;
    } else {
      payload.latitude = existing.latitude;
      payload.longitude = existing.longitude;
    }

    if (wasEditing) {
      payload.updatedAt = serverTimestamp();
      await updateDoc(doc(db, "installations", editingId), payload);
    } else {
      payload.createdAt = serverTimestamp();
      payload.updatedAt = serverTimestamp();
      await addDoc(collection(db, "installations"), payload);
    }

    closeRecordDialog();
    showToast(wasEditing ? "Installation updated." : "Installation saved.");
    await loadRecords();
  } catch (error) {
    console.error("Save failed:", error);
    showToast("Could not save installation: " + friendlyError(error), true);
  } finally {
    button.disabled = false;
    button.textContent = "Save installation";
  }
}

async function deleteRecord(id) {
  const record = records.find((item) => item.id === id);
  if (!record) return;

  const ok = window.confirm("Delete this installation?\n\n" + fullAddress(record));
  if (!ok) return;

  try {
    await deleteDoc(doc(db, "installations", id));
    showToast("Installation deleted.");
    await loadRecords();
  } catch (error) {
    showToast("Could not delete installation: " + friendlyError(error), true);
  }
}

function normalizeGeoText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(street)\b/g, "st")
    .replace(/\b(road)\b/g, "rd")
    .replace(/\b(avenue)\b/g, "ave")
    .replace(/\b(boulevard)\b/g, "blvd")
    .replace(/\b(drive)\b/g, "dr")
    .replace(/\b(lane)\b/g, "ln")
    .replace(/\b(highway)\b/g, "hwy")
    .replace(/\b(route)\b/g, "rte")
    .replace(/\b(north)\b/g, "n")
    .replace(/\b(south)\b/g, "s")
    .replace(/\b(east)\b/g, "e")
    .replace(/\b(west)\b/g, "w")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function parseStreet(value) {
  const cleaned = String(value || "")
    .replace(/\s+(apt|apartment|unit|suite|ste|#)\s*.*$/i, "")
    .trim();
  const match = cleaned.match(/^(\d+[a-zA-Z0-9-]*)\s+(.+)$/);
  return { full: cleaned, house: match ? match[1] : "", road: match ? match[2] : cleaned };
}

function resultRoad(address = {}) {
  return address.road || address.residential || address.pedestrian ||
    address.highway || address.path || address.place || "";
}

function resultLocality(address = {}) {
  return address.city || address.town || address.village ||
    address.hamlet || address.municipality || address.county || "";
}

function roadCore(value) {
  const stop = new Set(["st","rd","ave","blvd","dr","ln","hwy","rte","ct","cir","pl","pkwy","way","ter"]);
  return normalizeGeoText(value).split(" ").filter((token) => token && !stop.has(token)).join(" ");
}

function isConfidentStreetMatch(result, record) {
  const address = result.address || {};
  const inputStreet = parseStreet(record.address_line1);
  const inputRoad = roadCore(inputStreet.road);
  const matchedRoad = roadCore(resultRoad(address));
  const resultHouse = normalizeGeoText(address.house_number || "");

  if (inputStreet.house && resultHouse !== normalizeGeoText(inputStreet.house)) return false;

  if (inputRoad && matchedRoad) {
    const roadMatches = matchedRoad.includes(inputRoad) || inputRoad.includes(matchedRoad);
    if (!roadMatches) return false;
  } else if (inputRoad) {
    const display = normalizeGeoText(result.display_name || "");
    if (!display.includes(inputRoad)) return false;
  }

  const city = normalizeGeoText(normalizeCity(record.city, record.state));
  const locality = normalizeGeoText(resultLocality(address));
  const display = normalizeGeoText(result.display_name || "");
  if (city && locality && city !== locality && !display.includes(city)) return false;

  const inputZip = String(record.postal_code || "").trim().slice(0, 5);
  const resultZip = String(address.postcode || "").trim().slice(0, 5);
  if (inputZip && resultZip && inputZip !== resultZip) return false;

  return Number.isFinite(Number(result.lat)) && Number.isFinite(Number(result.lon));
}

function censusJsonp(url, timeoutMs = 12000) {
  return new Promise((resolve) => {
    const callbackName = "__censusGeocode_" + Date.now() + "_" + Math.random().toString(36).slice(2);
    const script = document.createElement("script");
    let finished = false;

    const cleanup = () => {
      if (finished) return;
      finished = true;
      delete window[callbackName];
      script.remove();
    };

    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);

    window[callbackName] = (data) => {
      clearTimeout(timer);
      cleanup();
      resolve(data);
    };

    script.onerror = () => {
      clearTimeout(timer);
      cleanup();
      resolve(null);
    };

    const separator = url.includes("?") ? "&" : "?";
    script.src = url + separator + "format=jsonp&callback=" + encodeURIComponent(callbackName);
    document.head.appendChild(script);
  });
}

async function censusGeocode(record) {
  try {
    const address = fullAddress(record);
    if (!address) return null;

    const params = new URLSearchParams({
      address,
      benchmark: "Public_AR_Current"
    });

    const data = await censusJsonp(
      "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?" + params.toString()
    );

    const match = data?.result?.addressMatches?.[0];
    const x = Number(match?.coordinates?.x);
    const y = Number(match?.coordinates?.y);

    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

    return { lat: y, lng: x, source: "Census" };
  } catch (error) {
    console.warn("Census geocoder failed:", error);
    return null;
  }
}

async function nominatimSearch(url) {
  try {
    const response = await fetch(url, {
      headers: { "Accept": "application/json", "Accept-Language": "en" }
    });
    if (!response.ok) return [];
    return await response.json();
  } catch (error) {
    console.warn("OpenStreetMap geocoding request failed:", error);
    return [];
  }
}

async function nominatimGeocode(record) {
  const street = parseStreet(record.address_line1).full;
  const city = normalizeCity(record.city, record.state);
  const state = String(record.state || "").trim();
  const zip = String(record.postal_code || "").trim();

  const structured = new URLSearchParams({
    format: "jsonv2",
    limit: "5",
    addressdetails: "1",
    countrycodes: "us",
    street
  });
  if (city) structured.set("city", city);
  if (state) structured.set("state", state);
  if (zip) structured.set("postalcode", zip);

  let results = await nominatimSearch(
    "https://nominatim.openstreetmap.org/search?" + structured.toString()
  );

  let match = results.find((result) => isConfidentStreetMatch(result, record));

  if (!match) {
    const full = [street, city, state, zip].filter(Boolean).join(", ");
    const freeform = new URLSearchParams({
      format: "jsonv2",
      limit: "5",
      addressdetails: "1",
      countrycodes: "us",
      q: full
    });

    results = await nominatimSearch(
      "https://nominatim.openstreetmap.org/search?" + freeform.toString()
    );
    match = results.find((result) => isConfidentStreetMatch(result, record));
  }

  if (!match) return null;
  return { lat: Number(match.lat), lng: Number(match.lon), source: "OpenStreetMap" };
}

async function geocodeRecord(record) {
  // The U.S. Census geocoder handles many street addresses that OpenStreetMap
  // does not contain, especially rural addresses. Use it first, then fall back
  // to a strict OpenStreetMap street/house-number match.
  const census = await censusGeocode(record);
  if (census) return census;

  return await nominatimGeocode(record);
}

async function backfillMissingCoordinates() {
  if (!currentUser) return;

  const missing = records.filter((record) =>
    (record.latitude == null || record.longitude == null) &&
    !geocodeAttempted.has(record.id)
  );

  if (!missing.length) return;

  showToast("Locating " + missing.length + " installation" + (missing.length === 1 ? "" : "s") + " for the map...");

  for (const record of missing) {
    geocodeAttempted.add(record.id);

    const coords = await geocodeRecord(record);
    if (coords) {
      try {
        await updateDoc(doc(db, "installations", record.id), {
          latitude: coords.lat,
          longitude: coords.lng,
          geocodeSource: coords.source || null,
          updatedAt: serverTimestamp()
        });

        record.latitude = coords.lat;
        record.longitude = coords.lng;
        record.geocodeSource = coords.source || null;
        renderMapMarkers();
      } catch (error) {
        console.warn("Could not save map coordinates:", error);
      }
    }

    // Avoid hammering free public geocoding services.
    await new Promise((resolve) => setTimeout(resolve, 800));
  }

  const stillMissing = records.filter((record) =>
    record.latitude == null || record.longitude == null
  ).length;

  if (stillMissing) {
    showToast(
      stillMissing + " address" + (stillMissing === 1 ? "" : "es") +
      " could not be pinned automatically. Tap Map on that record to open the address.",
      true
    );
  } else {
    showToast("Map pins updated.");
  }
}

async function retryMapPins() {
  if (!currentUser) return;
  geocodeAttempted.clear();

  const button = el("retryPinsBtn");
  button.disabled = true;
  button.textContent = "Locating...";

  try {
    await backfillMissingCoordinates();
  } finally {
    button.disabled = false;
    button.textContent = "Retry missing pins";
  }
}

function closePinPicker() {
  pinPickerRecordId = null;
  pinPickerMarker = null;
  el("pinDialog").close();
}

function setPinPickerMarker(lat, lng) {
  if (!pinPickerMap) return;

  if (pinPickerMarker) {
    pinPickerMarker.setLatLng([lat, lng]);
  } else {
    pinPickerMarker = L.marker([lat, lng], { draggable: true }).addTo(pinPickerMap);
    pinPickerMarker.on("dragend", () => {
      const point = pinPickerMarker.getLatLng();
      el("pinCoordinates").textContent = point.lat.toFixed(6) + ", " + point.lng.toFixed(6);
    });
  }

  el("pinCoordinates").textContent = Number(lat).toFixed(6) + ", " + Number(lng).toFixed(6);
}

function openPinPicker(id) {
  const record = records.find((item) => item.id === id);
  if (!record) return;

  pinPickerRecordId = id;
  pinPickerMarker = null;
  el("pinDialogTitle").textContent = "Set map pin";
  el("pinAddress").textContent = fullAddress(record);
  el("pinCoordinates").textContent = "Click the exact installation location on the map.";
  el("pinDialog").showModal();

  setTimeout(() => {
    if (!pinPickerMap) {
      pinPickerMap = L.map("pinPickerMap").setView([37.8, -96], 4);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap contributors'
      }).addTo(pinPickerMap);

      pinPickerMap.on("click", (event) => {
        setPinPickerMarker(event.latlng.lat, event.latlng.lng);
      });
    }

    pinPickerMap.invalidateSize();

    if (record.latitude != null && record.longitude != null) {
      setPinPickerMarker(Number(record.latitude), Number(record.longitude));
      pinPickerMap.setView([record.latitude, record.longitude], 17);
    } else {
      pinPickerMap.setView([37.8, -96], 4);

      // Make one best-effort automatic lookup to get the map near the address.
      void geocodeRecord(record).then((coords) => {
        if (!coords || pinPickerRecordId !== id) return;
        setPinPickerMarker(coords.lat, coords.lng);
        pinPickerMap.setView([coords.lat, coords.lng], 17);
      });
    }
  }, 100);
}

async function savePinPicker() {
  if (!currentUser || !pinPickerRecordId || !pinPickerMarker) {
    showToast("Click the installation location on the map first.", true);
    return;
  }

  const point = pinPickerMarker.getLatLng();
  const button = el("savePinBtn");
  button.disabled = true;
  button.textContent = "Saving...";

  try {
    await updateDoc(doc(db, "installations", pinPickerRecordId), {
      latitude: point.lat,
      longitude: point.lng,
      geocodeSource: "Manual",
      updatedAt: serverTimestamp()
    });

    const record = records.find((item) => item.id === pinPickerRecordId);
    if (record) {
      record.latitude = point.lat;
      record.longitude = point.lng;
      record.geocodeSource = "Manual";
    }

    renderRecords();
    renderMapMarkers();
    closePinPicker();
    showToast("Map pin saved.");
  } catch (error) {
    showToast("Could not save map pin: " + friendlyError(error), true);
  } finally {
    button.disabled = false;
    button.textContent = "Save pin";
  }
}

function toggleMap() {
  const panel = el("mapPanel");
  const opening = panel.classList.contains("hidden");
  panel.classList.toggle("hidden");
  el("mapToggleBtn").textContent = opening ? "Hide map" : "Show map";

  if (opening) {
    ensureMap();
    setTimeout(() => {
      map.invalidateSize();
      fitMap();
    }, 120);
  }
}

function ensureMap() {
  if (map) return;
  map = L.map("map").setView([37.8, -96], 4);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);
  markerLayer = L.layerGroup().addTo(map);
  renderMapMarkers();
}

function renderMapMarkers() {
  if (!map || !markerLayer) return;

  markerLayer.clearLayers();
  getFilteredRecords()
    .filter((record) => record.latitude != null && record.longitude != null)
    .forEach((record) => {
      const pinIcon = L.divIcon({
        className: "installation-pin-icon",
        html: '<div class="installation-pin-dot"><span></span></div>',
        iconSize: [34, 42],
        iconAnchor: [17, 42],
        tooltipAnchor: [0, -36]
      });

      const marker = L.marker([record.latitude, record.longitude], {
        icon: pinIcon,
        title: fullAddress(record)
      }).addTo(markerLayer);

      marker.bindTooltip(
        "<strong>" + esc(fullAddress(record)) + "</strong><br>" +
        esc(joinParts(record.manufacturer, record.model_number) || "Garage door") +
        (record.door_size ? "<br>" + esc(record.door_size) : "") +
        "<br><em>Click to open record</em>",
        { direction: "top", offset: [0, -8] }
      );

      marker.on("click", () => openRecordDialog(record.id));
      marker.options.recordId = record.id;
    });

  fitMap();
}

function fitMap() {
  if (!map || !markerLayer) return;
  const layers = markerLayer.getLayers();

  if (!layers.length) {
    map.setView([37.8, -96], 4);
    return;
  }

  if (layers.length === 1) map.setView(layers[0].getLatLng(), 14);
  else map.fitBounds(L.featureGroup(layers).getBounds().pad(0.15));
}

function focusRecordOnMap(id) {
  const record = records.find((item) => item.id === id);
  if (!record) return;

  if (record.latitude == null || record.longitude == null) {
    openPinPicker(id);
    return;
  }

  if (el("mapPanel").classList.contains("hidden")) toggleMap();
  ensureMap();

  setTimeout(() => {
    map.invalidateSize();
    map.setView([record.latitude, record.longitude], 16);
    const marker = markerLayer.getLayers().find((layer) => layer.options.recordId === id);
    if (marker) marker.openTooltip();
  }, 150);
}

function exportCsv() {
  if (!records.length) {
    showToast("Nothing to export.", true);
    return;
  }

  const columns = [
    "customer_name","address_line1","city","state","postal_code","manufacturer",
    "model_number","door_size","spring_size","spring_count","door_type","color",
    "lift_type","install_date","extraDoors","notes"
  ];

  const rows = [columns].concat(
    records.map((record) => columns.map((column) => {
      if (column === "extraDoors") return JSON.stringify(record.extraDoors || []);
      return record[column] ?? "";
    }))
  );

  const csv = rows.map((row) => row.map(csvValue).join(",")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "garage-door-installations-" + new Date().toISOString().slice(0, 10) + ".csv";
  a.click();
  URL.revokeObjectURL(url);
}

function csvValue(value) {
  return '"' + String(value ?? "").replaceAll('"', '""') + '"';
}

function normalizeCity(city, state) {
  let value = String(city || "").trim();
  const stateValue = String(state || "").trim();

  if (!value || !stateValue) return value;
  const lowerValue = value.toLowerCase();
  const lowerState = stateValue.toLowerCase();

  if (lowerValue.endsWith(", " + lowerState)) {
    value = value.slice(0, -(stateValue.length + 2)).trim();
  } else if (lowerValue.endsWith(" " + lowerState)) {
    value = value.slice(0, -(stateValue.length + 1)).trim();
  }

  return value.replace(/,\s*$/, "").trim();
}

function fullAddress(record) {
  const city = normalizeCity(record.city, record.state);
  return [record.address_line1, city, record.state, record.postal_code]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(", ");
}

function joinParts(a, b) {
  return [a, b].filter(Boolean).join(" ");
}

function formatDate(value) {
  if (!value) return "";
  const parts = String(value).split("-");
  if (parts.length !== 3) return value;
  return Number(parts[1]) + "/" + Number(parts[2]) + "/" + parts[0];
}

function friendlyError(error) {
  return String(error?.message || error?.code || "Unknown error")
    .replace(/^Firebase:\s*/i, "")
    .replace(/\s*\(auth\/[^)]+\)\.?$/i, "")
    .replace(/\s*\(firestore\/[^)]+\)\.?$/i, "");
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

let toastTimer;
function showToast(message, isError = false) {
  clearTimeout(toastTimer);
  el("toast").textContent = message;
  el("toast").classList.toggle("error", !!isError);
  el("toast").classList.remove("hidden");
  toastTimer = setTimeout(() => el("toast").classList.add("hidden"), 4500);
}
