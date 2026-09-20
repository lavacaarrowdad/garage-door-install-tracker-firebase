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
let properties = [];
let editingPropertyId = null;
let map = null;
let markerLayer = null;
let pinPickerMap = null;
let pinPickerMarker = null;
let pinPickerPropertyId = null;
const geocodeAttempted = new Set();

const el = (id) => document.getElementById(id);
const propertyFields = ["customer_name", "address_line1", "city", "state", "postal_code", "property_notes"];
const doorFields = ["manufacturer", "model_number", "door_size", "spring_size", "spring_count", "door_type", "color", "lift_type", "install_date", "notes"];
const openerFields = ["manufacturer", "model_number", "serial_number", "opener_type", "horsepower", "install_date", "notes"];
const serviceFields = ["service_date", "service_type", "asset_reference", "description", "notes"];

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

  el("addPropertyBtn").addEventListener("click", () => openPropertyDialog());
  el("addDoorBtn").addEventListener("click", () => addDoorCard());
  el("addOpenerBtn").addEventListener("click", () => addOpenerCard());
  el("addServiceBtn").addEventListener("click", () => addServiceCard());

  el("searchForm").addEventListener("submit", (event) => {
    event.preventDefault();
    renderProperties();
    renderMapMarkers();
  });
  el("searchInput").addEventListener("input", () => {
    renderProperties();
    renderMapMarkers();
  });
  el("clearSearchBtn").addEventListener("click", () => {
    el("searchInput").value = "";
    renderProperties();
    renderMapMarkers();
    el("searchInput").focus();
  });

  el("mapToggleBtn").addEventListener("click", toggleMap);
  el("retryPinsBtn").addEventListener("click", retryMapPins);
  el("exportBtn").addEventListener("click", exportCsv);

  el("propertyForm").addEventListener("submit", saveProperty);
  el("closePropertyDialogBtn").addEventListener("click", closePropertyDialog);
  el("cancelPropertyBtn").addEventListener("click", closePropertyDialog);

  el("closePinDialogBtn").addEventListener("click", closePinPicker);
  el("cancelPinBtn").addEventListener("click", closePinPicker);
  el("savePinBtn").addEventListener("click", savePinPicker);
  el("openAddressBtn").addEventListener("click", () => {
    const property = properties.find((item) => item.id === pinPickerPropertyId);
    if (!property) return;
    window.open(
      "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(fullAddress(property)),
      "_blank",
      "noopener"
    );
  });

  el("propertyDialog").addEventListener("click", (event) => {
    if (event.target === el("propertyDialog")) closePropertyDialog();
  });
}

async function syncAuthView() {
  const signedIn = !!currentUser;
  el("authView").classList.toggle("hidden", signedIn);
  el("appView").classList.toggle("hidden", !signedIn);
  el("userArea").classList.toggle("hidden", !signedIn);

  if (signedIn) {
    el("userEmail").textContent = currentUser.email || "";
    await loadProperties();
  } else {
    properties = [];
    el("propertiesList").innerHTML = "";
    el("propertyCount").textContent = "0";
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

function normalizeProperty(raw) {
  const doors = Array.isArray(raw.doors) ? raw.doors.map((door) => ({ ...door })) : [];
  const hasLegacyDoor = [
    raw.manufacturer, raw.model_number, raw.door_size, raw.spring_size,
    raw.spring_count, raw.door_type, raw.color, raw.lift_type, raw.install_date
  ].some((value) => value !== null && value !== undefined && String(value).trim() !== "");

  let needsMigration = false;
  if (!doors.length) {
    if (hasLegacyDoor) {
      doors.push({
        manufacturer: raw.manufacturer ?? null,
        model_number: raw.model_number ?? null,
        door_size: raw.door_size ?? null,
        spring_size: raw.spring_size ?? null,
        spring_count: raw.spring_count ?? null,
        door_type: raw.door_type ?? null,
        color: raw.color ?? null,
        lift_type: raw.lift_type ?? null,
        install_date: raw.install_date ?? null,
        notes: null
      });
    }

    if (Array.isArray(raw.extraDoors)) {
      raw.extraDoors.forEach((door) => doors.push({ ...door }));
    }

    if (hasLegacyDoor || (Array.isArray(raw.extraDoors) && raw.extraDoors.length)) {
      needsMigration = true;
    }
  }

  return {
    ...raw,
    doors,
    openers: Array.isArray(raw.openers) ? raw.openers.map((item) => ({ ...item })) : [],
    serviceCalls: Array.isArray(raw.serviceCalls)
      ? raw.serviceCalls.map((item) => ({ ...item }))
      : (Array.isArray(raw.service_calls) ? raw.service_calls.map((item) => ({ ...item })) : []),
    property_notes: raw.property_notes ?? raw.notes ?? null,
    _needsMigration: needsMigration
  };
}

async function loadProperties() {
  if (!currentUser) return;

  try {
    const q = query(
      collection(db, "installations"),
      where("userId", "==", currentUser.uid)
    );

    const snapshot = await getDocs(q);
    properties = snapshot.docs.map((snap) => normalizeProperty({ id: snap.id, ...snap.data() }));

    properties.sort((a, b) => {
      const customerCompare = String(a.customer_name || "").localeCompare(String(b.customer_name || ""));
      if (customerCompare !== 0) return customerCompare;
      return fullAddress(a).localeCompare(fullAddress(b));
    });

    renderProperties();
    ensureMap();
    renderMapMarkers();
    void migrateLegacyProperties();
    void backfillMissingCoordinates();
  } catch (error) {
    console.error("Load failed:", error);
    showToast("Could not load properties: " + friendlyError(error), true);
  }
}

async function migrateLegacyProperties() {
  const legacy = properties.filter((property) => property._needsMigration);
  for (const property of legacy) {
    try {
      await updateDoc(doc(db, "installations", property.id), {
        doors: property.doors,
        property_notes: property.property_notes ?? null,
        updatedAt: serverTimestamp()
      });
      property._needsMigration = false;
    } catch (error) {
      console.warn("Could not migrate legacy property record:", error);
    }
  }
}

function getFilteredProperties() {
  const queryText = el("searchInput").value.trim().toLowerCase();
  if (!queryText) return properties;
  const terms = queryText.split(/\s+/).filter(Boolean);

  return properties.filter((property) => {
    const haystack = [
      property.customer_name,
      property.address_line1,
      property.city,
      property.state,
      property.postal_code,
      property.property_notes,
      JSON.stringify(property.doors || []),
      JSON.stringify(property.openers || []),
      JSON.stringify(property.serviceCalls || [])
    ].map((value) => String(value || "").toLowerCase()).join(" ");

    return terms.every((term) => haystack.includes(term));
  });
}

function renderProperties() {
  const filtered = getFilteredProperties();
  const queryText = el("searchInput").value.trim();

  el("propertyCount").textContent = properties.length;
  el("filterCount").textContent = queryText ? filtered.length + " matching" : "";
  el("emptyState").classList.toggle("hidden", properties.length !== 0);

  if (!filtered.length) {
    el("propertiesList").innerHTML = properties.length
      ? '<div class="empty-state"><h3>No matches</h3><p>Try a different search.</p></div>'
      : "";
    return;
  }

  el("propertiesList").innerHTML = filtered.map(propertyCardHtml).join("");

  document.querySelectorAll("[data-manage]").forEach((button) => {
    button.addEventListener("click", () => openPropertyDialog(button.dataset.manage));
  });
  document.querySelectorAll("[data-map]").forEach((button) => {
    button.addEventListener("click", () => focusPropertyOnMap(button.dataset.map));
  });
  document.querySelectorAll("[data-delete]").forEach((button) => {
    button.addEventListener("click", () => deleteProperty(button.dataset.delete));
  });
}

function propertyCardHtml(property) {
  const doors = property.doors || [];
  const openers = property.openers || [];
  const serviceCalls = sortServiceCalls(property.serviceCalls || []);
  const recent = serviceCalls.slice(0, 3);

  return '<article class="record-card property-card">' +
    '<div class="record-top"><div>' +
      (property.customer_name ? '<div class="eyebrow">' + esc(property.customer_name) + '</div>' : '') +
      '<div class="record-address">' + esc(fullAddress(property) || "No address") + '</div>' +
    '</div></div>' +
    '<div class="property-counts">' +
      '<span><strong>' + doors.length + '</strong> door' + (doors.length === 1 ? '' : 's') + '</span>' +
      '<span><strong>' + openers.length + '</strong> opener' + (openers.length === 1 ? '' : 's') + '</span>' +
      '<span><strong>' + serviceCalls.length + '</strong> service call' + (serviceCalls.length === 1 ? '' : 's') + '</span>' +
    '</div>' +
    (doors.length ? '<div class="property-subsection"><span class="subsection-title">Doors</span>' +
      doors.slice(0, 3).map((door, index) => '<div class="asset-line"><strong>Door ' + (index + 1) + '</strong><span>' + esc(doorSummary(door)) + '</span></div>').join("") +
      (doors.length > 3 ? '<div class="muted">+' + (doors.length - 3) + ' more</div>' : '') +
      '</div>' : '') +
    (openers.length ? '<div class="property-subsection"><span class="subsection-title">Openers</span>' +
      openers.slice(0, 3).map((opener, index) => '<div class="asset-line"><strong>Opener ' + (index + 1) + '</strong><span>' + esc(openerSummary(opener)) + '</span></div>').join("") +
      (openers.length > 3 ? '<div class="muted">+' + (openers.length - 3) + ' more</div>' : '') +
      '</div>' : '') +
    (recent.length ? '<div class="property-subsection"><span class="subsection-title">Recent service history</span>' +
      recent.map((call) => '<div class="service-line"><strong>' + esc(formatDate(call.service_date) || "No date") + '</strong><span>' + esc(serviceSummary(call)) + '</span></div>').join("") +
      (serviceCalls.length > 3 ? '<div class="muted">+' + (serviceCalls.length - 3) + ' older service call' + (serviceCalls.length - 3 === 1 ? '' : 's') + '</div>' : '') +
      '</div>' : '') +
    (property.property_notes ? '<p class="muted">' + esc(property.property_notes) + '</p>' : '') +
    '<div class="record-actions">' +
      '<button class="button primary small" data-manage="' + esc(property.id) + '">Manage</button>' +
      '<button class="button secondary small" data-map="' + esc(property.id) + '">' +
        (property.latitude != null && property.longitude != null ? "Map" : "Set pin") +
      '</button>' +
      '<button class="button danger small" data-delete="' + esc(property.id) + '">Delete</button>' +
    '</div>' +
  '</article>';
}

function doorSummary(door) {
  const parts = [
    joinParts(door.manufacturer, door.model_number),
    door.door_size,
    door.door_type,
    door.color,
    door.lift_type
  ].filter(Boolean);
  return parts.join(" • ") || "Garage door";
}

function openerSummary(opener) {
  const parts = [
    joinParts(opener.manufacturer, opener.model_number),
    opener.opener_type,
    opener.horsepower,
    opener.serial_number ? "S/N " + opener.serial_number : ""
  ].filter(Boolean);
  return parts.join(" • ") || "Garage door opener";
}

function serviceSummary(call) {
  const parts = [call.service_type, call.asset_reference, call.description].filter(Boolean);
  return parts.join(" • ") || call.notes || "Service call";
}

function sortServiceCalls(calls) {
  return [...calls].sort((a, b) => String(b.service_date || "").localeCompare(String(a.service_date || "")));
}

function openPropertyDialog(id) {
  editingPropertyId = id || null;
  el("propertyForm").reset();
  el("doorsContainer").innerHTML = "";
  el("openersContainer").innerHTML = "";
  el("serviceContainer").innerHTML = "";

  if (editingPropertyId) {
    const property = properties.find((item) => item.id === editingPropertyId);
    if (!property) return;

    el("propertyDialogTitle").textContent = "Manage property";
    propertyFields.forEach((name) => {
      el(name).value = property[name] ?? "";
    });

    (property.doors || []).forEach((door) => addDoorCard(door));
    (property.openers || []).forEach((opener) => addOpenerCard(opener));
    sortServiceCalls(property.serviceCalls || []).forEach((call) => addServiceCard(call));
  } else {
    el("propertyDialogTitle").textContent = "Add property";
  }

  el("propertyDialog").showModal();
}

function closePropertyDialog() {
  editingPropertyId = null;
  el("propertyDialog").close();
}

function addDoorCard(door = {}) {
  if (Object.keys(door).length === 0) door = { install_date: "" };
  const card = document.createElement("div");
  card.className = "asset-editor";
  card.innerHTML =
    '<div class="asset-editor-header"><strong>Door</strong><button class="button danger small remove-asset" type="button">Remove</button></div>' +
    '<div class="extra-door-grid">' +
      '<label>Manufacturer<input data-door-field="manufacturer" placeholder="Clopay, Wayne Dalton..."></label>' +
      '<label>Model #<input data-door-field="model_number"></label>' +
      '<label>Door size<input data-door-field="door_size" placeholder="16 x 7"></label>' +
      '<label>Spring size<input data-door-field="spring_size" placeholder=".250 x 2 x 31"></label>' +
      '<label>Number of springs<input data-door-field="spring_count" type="number" min="0" step="1"></label>' +
      '<label>Door type<input data-door-field="door_type" list="doorTypes" placeholder="Raised panel"></label>' +
      '<label>Color<input data-door-field="color" list="colors" placeholder="White"></label>' +
      '<label>Lift<input data-door-field="lift_type" list="liftTypes" placeholder="Standard lift"></label>' +
      '<label>Install date<input data-door-field="install_date" type="date"></label>' +
      '<label class="span-2">Door notes<textarea data-door-field="notes" rows="2"></textarea></label>' +
    '</div>';

  fillAssetCard(card, doorFields, "door-field", door);
  card.querySelector(".remove-asset").addEventListener("click", () => {
    card.remove();
    renumberEditors("doorsContainer", "Door");
  });
  el("doorsContainer").appendChild(card);
  renumberEditors("doorsContainer", "Door");
}

function addOpenerCard(opener = {}) {
  if (Object.keys(opener).length === 0) opener = { install_date: "" };
  const card = document.createElement("div");
  card.className = "asset-editor";
  card.innerHTML =
    '<div class="asset-editor-header"><strong>Opener</strong><button class="button danger small remove-asset" type="button">Remove</button></div>' +
    '<div class="extra-door-grid">' +
      '<label>Manufacturer<input data-opener-field="manufacturer" placeholder="LiftMaster, Genie..."></label>' +
      '<label>Model #<input data-opener-field="model_number"></label>' +
      '<label>Serial #<input data-opener-field="serial_number"></label>' +
      '<label>Opener type<input data-opener-field="opener_type" list="openerTypes" placeholder="Belt drive"></label>' +
      '<label>HP / rating<input data-opener-field="horsepower" placeholder="3/4 HP"></label>' +
      '<label>Install date<input data-opener-field="install_date" type="date"></label>' +
      '<label class="span-2">Opener notes<textarea data-opener-field="notes" rows="2"></textarea></label>' +
    '</div>';

  fillAssetCard(card, openerFields, "opener-field", opener);
  card.querySelector(".remove-asset").addEventListener("click", () => {
    card.remove();
    renumberEditors("openersContainer", "Opener");
  });
  el("openersContainer").appendChild(card);
  renumberEditors("openersContainer", "Opener");
}

function addServiceCard(call = {}) {
  const card = document.createElement("div");
  card.className = "asset-editor service-editor";
  card.innerHTML =
    '<div class="asset-editor-header"><strong>Service call</strong><button class="button danger small remove-asset" type="button">Remove</button></div>' +
    '<div class="extra-door-grid">' +
      '<label>Service date<input data-service-field="service_date" type="date"></label>' +
      '<label>Type<select data-service-field="service_type"><option value="">Select...</option><option>Door</option><option>Opener</option><option>General</option></select></label>' +
      '<label>Door / opener reference<input data-service-field="asset_reference" placeholder="Door 1, Opener 2..."></label>' +
      '<label class="span-2">Work performed / issue<input data-service-field="description" placeholder="Replaced spring, adjusted limits..."></label>' +
      '<label class="span-2">Service notes<textarea data-service-field="notes" rows="2"></textarea></label>' +
    '</div>';

  const serviceData = { ...call };
  if (!serviceData.service_date && Object.keys(call).length === 0) {
    serviceData.service_date = new Date().toISOString().slice(0, 10);
  }
  fillAssetCard(card, serviceFields, "service-field", serviceData);
  card.querySelector(".remove-asset").addEventListener("click", () => {
    card.remove();
    renumberEditors("serviceContainer", "Service call");
  });
  el("serviceContainer").appendChild(card);
  renumberEditors("serviceContainer", "Service call");
}

function fillAssetCard(card, fieldNames, dataAttr, data) {
  fieldNames.forEach((name) => {
    const input = card.querySelector('[data-' + dataAttr + '="' + name + '"]');
    if (!input) return;
    input.value = data[name] ?? "";
  });
}

function renumberEditors(containerId, label) {
  el(containerId).querySelectorAll(".asset-editor").forEach((card, index) => {
    const title = card.querySelector(".asset-editor-header strong");
    if (title) title.textContent = label + " " + (index + 1);
  });
}

function collectCards(containerId, fieldNames, dataAttr) {
  return Array.from(el(containerId).querySelectorAll(".asset-editor"))
    .map((card) => {
      const item = {};
      fieldNames.forEach((name) => {
        const input = card.querySelector('[data-' + dataAttr + '="' + name + '"]');
        if (!input) return;
        let value = String(input.value ?? "").trim();
        if (name === "spring_count") value = value === "" ? null : Number(value);
        item[name] = value === "" ? null : value;
      });
      return item;
    })
    .filter((item) => fieldNames.some((name) => item[name] !== null && item[name] !== ""));
}

async function saveProperty(event) {
  event.preventDefault();
  if (!currentUser) return;

  const wasEditing = !!editingPropertyId;
  const existing = wasEditing ? properties.find((item) => item.id === editingPropertyId) : null;

  const payload = {
    userId: currentUser.uid,
    doors: collectCards("doorsContainer", doorFields, "door-field"),
    openers: collectCards("openersContainer", openerFields, "opener-field"),
    serviceCalls: collectCards("serviceContainer", serviceFields, "service-field")
  };

  propertyFields.forEach((name) => {
    const value = el(name).value.trim();
    payload[name] = value === "" ? null : value;
  });

  if (!payload.address_line1 || !payload.city || !payload.state) {
    showToast("Street address, city and state are required.", true);
    return;
  }

  const button = el("savePropertyBtn");
  button.disabled = true;
  button.textContent = "Saving...";

  try {
    const addressChanged = !existing ||
      fullAddress(existing).toLowerCase() !== fullAddress(payload).toLowerCase();

    if (addressChanged || existing?.latitude == null || existing?.longitude == null) {
      const coords = await geocodeProperty(payload);
      payload.latitude = coords?.lat ?? null;
      payload.longitude = coords?.lng ?? null;
      payload.geocodeSource = coords?.source ?? null;
    } else {
      payload.latitude = existing.latitude;
      payload.longitude = existing.longitude;
      payload.geocodeSource = existing.geocodeSource ?? null;
    }

    // Clear the old one-door fields now that this document is a property record.
    Object.assign(payload, {
      manufacturer: null,
      model_number: null,
      door_size: null,
      spring_size: null,
      spring_count: null,
      door_type: null,
      color: null,
      lift_type: null,
      install_date: null,
      notes: null
    });

    if (wasEditing) {
      payload.updatedAt = serverTimestamp();
      await updateDoc(doc(db, "installations", editingPropertyId), payload);
    } else {
      payload.createdAt = serverTimestamp();
      payload.updatedAt = serverTimestamp();
      await addDoc(collection(db, "installations"), payload);
    }

    closePropertyDialog();
    showToast(wasEditing ? "Property updated." : "Property saved.");
    await loadProperties();
  } catch (error) {
    console.error("Save failed:", error);
    showToast("Could not save property: " + friendlyError(error), true);
  } finally {
    button.disabled = false;
    button.textContent = "Save property";
  }
}

async function deleteProperty(id) {
  const property = properties.find((item) => item.id === id);
  if (!property) return;

  const ok = window.confirm(
    "Delete this entire property and its door, opener, and service history?\n\n" + fullAddress(property)
  );
  if (!ok) return;

  try {
    await deleteDoc(doc(db, "installations", id));
    showToast("Property deleted.");
    await loadProperties();
  } catch (error) {
    showToast("Could not delete property: " + friendlyError(error), true);
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
  return address.road || address.residential || address.pedestrian || address.highway || address.path || address.place || "";
}

function resultLocality(address = {}) {
  return address.city || address.town || address.village || address.hamlet || address.municipality || address.county || "";
}

function roadCore(value) {
  const stop = new Set(["st","rd","ave","blvd","dr","ln","hwy","rte","ct","cir","pl","pkwy","way","ter"]);
  return normalizeGeoText(value).split(" ").filter((token) => token && !stop.has(token)).join(" ");
}

function isConfidentStreetMatch(result, property) {
  const address = result.address || {};
  const inputStreet = parseStreet(property.address_line1);
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

  const city = normalizeGeoText(normalizeCity(property.city, property.state));
  const locality = normalizeGeoText(resultLocality(address));
  const display = normalizeGeoText(result.display_name || "");
  if (city && locality && city !== locality && !display.includes(city)) return false;

  const inputZip = String(property.postal_code || "").trim().slice(0, 5);
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

async function censusGeocode(property) {
  const address = fullAddress(property);
  if (!address) return null;

  const params = new URLSearchParams({ address, benchmark: "Public_AR_Current" });
  const data = await censusJsonp(
    "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?" + params.toString()
  );

  const match = data?.result?.addressMatches?.[0];
  const lng = Number(match?.coordinates?.x);
  const lat = Number(match?.coordinates?.y);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng, source: "Census" };
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

async function nominatimGeocode(property) {
  const street = parseStreet(property.address_line1).full;
  const city = normalizeCity(property.city, property.state);
  const state = String(property.state || "").trim();
  const zip = String(property.postal_code || "").trim();

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
  let match = results.find((result) => isConfidentStreetMatch(result, property));

  if (!match) {
    const params = new URLSearchParams({
      format: "jsonv2",
      limit: "5",
      addressdetails: "1",
      countrycodes: "us",
      q: fullAddress(property)
    });
    results = await nominatimSearch("https://nominatim.openstreetmap.org/search?" + params.toString());
    match = results.find((result) => isConfidentStreetMatch(result, property));
  }

  if (!match) return null;
  return { lat: Number(match.lat), lng: Number(match.lon), source: "OpenStreetMap" };
}

async function geocodeProperty(property) {
  const census = await censusGeocode(property);
  if (census) return census;
  return await nominatimGeocode(property);
}

async function backfillMissingCoordinates() {
  if (!currentUser) return;
  const missing = properties.filter((property) =>
    (property.latitude == null || property.longitude == null) &&
    !geocodeAttempted.has(property.id)
  );
  if (!missing.length) return;

  showToast("Locating " + missing.length + " propert" + (missing.length === 1 ? "y" : "ies") + " for the map...");

  for (const property of missing) {
    geocodeAttempted.add(property.id);
    const coords = await geocodeProperty(property);
    if (coords) {
      try {
        await updateDoc(doc(db, "installations", property.id), {
          latitude: coords.lat,
          longitude: coords.lng,
          geocodeSource: coords.source || null,
          updatedAt: serverTimestamp()
        });
        property.latitude = coords.lat;
        property.longitude = coords.lng;
        property.geocodeSource = coords.source || null;
        renderMapMarkers();
      } catch (error) {
        console.warn("Could not save map coordinates:", error);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
  }

  const stillMissing = properties.filter((property) =>
    property.latitude == null || property.longitude == null
  ).length;

  if (stillMissing) {
    showToast(
      stillMissing + " propert" + (stillMissing === 1 ? "y" : "ies") +
      " still need a manual pin. Use Set pin on the property.",
      true
    );
  } else {
    showToast("Map pins updated.");
  }
}

async function retryMapPins() {
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

  getFilteredProperties()
    .filter((property) => property.latitude != null && property.longitude != null)
    .forEach((property) => {
      const pinIcon = L.divIcon({
        className: "installation-pin-icon",
        html: '<div class="installation-pin-dot"><span></span></div>',
        iconSize: [34, 42],
        iconAnchor: [17, 42],
        tooltipAnchor: [0, -36]
      });

      const marker = L.marker([property.latitude, property.longitude], {
        icon: pinIcon,
        title: fullAddress(property)
      }).addTo(markerLayer);

      marker.bindTooltip(
        "<strong>" + esc(property.customer_name || fullAddress(property)) + "</strong><br>" +
        esc(fullAddress(property)) + "<br>" +
        (property.doors || []).length + " door(s) • " +
        (property.openers || []).length + " opener(s) • " +
        (property.serviceCalls || []).length + " service call(s)",
        { direction: "top", offset: [0, -8] }
      );

      marker.on("click", () => openPropertyDialog(property.id));
      marker.options.propertyId = property.id;
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

function focusPropertyOnMap(id) {
  const property = properties.find((item) => item.id === id);
  if (!property) return;

  if (property.latitude == null || property.longitude == null) {
    openPinPicker(id);
    return;
  }

  if (el("mapPanel").classList.contains("hidden")) toggleMap();
  ensureMap();

  setTimeout(() => {
    map.invalidateSize();
    map.setView([property.latitude, property.longitude], 16);
    const marker = markerLayer.getLayers().find((layer) => layer.options.propertyId === id);
    if (marker) marker.openTooltip();
  }, 150);
}

function closePinPicker() {
  pinPickerPropertyId = null;
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
  const property = properties.find((item) => item.id === id);
  if (!property) return;

  pinPickerPropertyId = id;
  pinPickerMarker = null;
  el("pinAddress").textContent = fullAddress(property);
  el("pinCoordinates").textContent = "Click the exact property location on the map.";
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

    if (property.latitude != null && property.longitude != null) {
      setPinPickerMarker(Number(property.latitude), Number(property.longitude));
      pinPickerMap.setView([property.latitude, property.longitude], 17);
    } else {
      pinPickerMap.setView([37.8, -96], 4);
      void geocodeProperty(property).then((coords) => {
        if (!coords || pinPickerPropertyId !== id) return;
        setPinPickerMarker(coords.lat, coords.lng);
        pinPickerMap.setView([coords.lat, coords.lng], 17);
      });
    }
  }, 100);
}

async function savePinPicker() {
  if (!currentUser || !pinPickerPropertyId || !pinPickerMarker) {
    showToast("Click the property location on the map first.", true);
    return;
  }

  const point = pinPickerMarker.getLatLng();
  const button = el("savePinBtn");
  button.disabled = true;
  button.textContent = "Saving...";

  try {
    await updateDoc(doc(db, "installations", pinPickerPropertyId), {
      latitude: point.lat,
      longitude: point.lng,
      geocodeSource: "Manual",
      updatedAt: serverTimestamp()
    });

    const property = properties.find((item) => item.id === pinPickerPropertyId);
    if (property) {
      property.latitude = point.lat;
      property.longitude = point.lng;
      property.geocodeSource = "Manual";
    }

    renderProperties();
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

function exportCsv() {
  if (!properties.length) {
    showToast("Nothing to export.", true);
    return;
  }

  const columns = ["customer_name","address_line1","city","state","postal_code","doors","openers","serviceCalls","property_notes"];
  const rows = [columns].concat(
    properties.map((property) => columns.map((column) => {
      if (column === "doors") return JSON.stringify(property.doors || []);
      if (column === "openers") return JSON.stringify(property.openers || []);
      if (column === "serviceCalls") return JSON.stringify(property.serviceCalls || []);
      return property[column] ?? "";
    }))
  );

  const csv = rows.map((row) => row.map(csvValue).join(",")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "property-tracker-" + new Date().toISOString().slice(0, 10) + ".csv";
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

function fullAddress(property) {
  const city = normalizeCity(property.city, property.state);
  return [property.address_line1, city, property.state, property.postal_code]
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
  toastTimer = setTimeout(() => el("toast").classList.add("hidden"), 5000);
}
