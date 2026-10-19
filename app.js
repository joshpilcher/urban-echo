(() => {
  "use strict";
  const Core = window.EchoCore;
  const reducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;
  const STORAGE_KEY = "urban-echo-v1"; // Preserve memories from v0.1.
  const $ = (id) => document.getElementById(id);
  const pins = new Map();
  let map = null,
    userPin = null,
    accuracyCircle = null;
  let fix = null,
    watchId = null,
    generation = 0,
    expiryTimer = null;
  let filter = "all",
    echoes = [],
    storageProblem = "";
  let followNextFix = true,
    previousUnlocked = new Set();

  function node(type, className, value) {
    const el = document.createElement(type);
    if (className) el.className = className;
    if (value != null) el.textContent = value;
    return el;
  }
  function mapNotice(message) {
    $("map-notice").textContent = message;
    $("map-notice").hidden = !message;
  }
  function initMap() {
    if (!window.L) {
      mapNotice(
        "The map could not load. GPS and the memory list still work. Check your connection and reload for the map.",
      );
      return;
    }
    map = L.map("map", {
      zoomControl: false,
      fadeAnimation: !reducedMotion,
      zoomAnimation: !reducedMotion,
      markerZoomAnimation: !reducedMotion,
    }).setView([-26.65, 153.07], 12);
    L.control.zoom({ position: "bottomleft" }).addTo(map);
    const tiles = L.tileLayer(
      "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      {
        maxZoom: 19,
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      },
    ).addTo(map);
    tiles.on("tileerror", () =>
      mapNotice(
        "Map tiles are unavailable. Your GPS and Echo list still work.",
      ),
    );
    tiles.on("tileload", () => mapNotice(""));
    new ResizeObserver(() =>
      map.stop().invalidateSize({ animate: false }),
    ).observe($("map"));
  }
  function readEchoes() {
    storageProblem = "";
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const data = raw === null ? [] : JSON.parse(raw);
      if (!Array.isArray(data)) throw new Error("Invalid saved data");
      const seen = new Set();
      echoes = data.filter((e) => {
        if (!Core.validEcho(e) || seen.has(e.id)) return false;
        seen.add(e.id);
        return true;
      });
      if (echoes.length !== data.length)
        storageProblem =
          "Some saved memories are invalid. Saving is paused to preserve the original data.";
    } catch {
      echoes = [];
      storageProblem =
        "Saved memories could not be read. Saving is paused; existing data has not been overwritten.";
    }
  }
  function distanceLabel(m) {
    return m < 1000 ? Math.round(m) + " m" : (m / 1000).toFixed(1) + " km";
  }
  function clearUserLocation() {
    if (map && userPin) map.removeLayer(userPin);
    if (map && accuracyCircle) map.removeLayer(accuracyCircle);
    userPin = accuracyCircle = null;
  }
  function updateUserLocation() {
    if (!map || !fix) return;
    const latlng = [fix.lat, fix.lng];
    if (userPin) userPin.setLatLng(latlng);
    else
      userPin = L.marker(latlng, {
        icon: L.divIcon({
          className: "",
          html: '<span class="user-marker"></span>',
          iconSize: [20, 20],
        }),
      })
        .addTo(map)
        .bindTooltip("Your location");
    if (accuracyCircle)
      accuracyCircle.setLatLng(latlng).setRadius(fix.accuracy);
    else
      accuracyCircle = L.circle(latlng, {
        radius: fix.accuracy,
        color: "#4b95e8",
        weight: 1,
        fillOpacity: 0.08,
      }).addTo(map);
    if (followNextFix) {
      map.setView(latlng, 16);
      followNextFix = false;
    }
  }
  function updatePins(records) {
    if (!map) return;
    const ids = new Set(records.map((e) => e.id));
    for (const [id, pin] of pins)
      if (!ids.has(id)) {
        map.removeLayer(pin);
        pins.delete(id);
      }
    records.forEach((e) => {
      let pin = pins.get(e.id);
      const icon = L.divIcon({
        className: "",
        html:
          '<span class="echo-marker ' +
          (e.state === "unlocked" ? "is-unlocked" : "is-locked") +
          '"></span>',
        iconSize: [19, 19],
      });
      if (!pin) {
        pin = L.marker([e.lat, e.lng], { icon, title: e.title }).addTo(map);
        pin.on("click", () => {
          const card = [...$("echo-list").children].find(
            (c) => c.dataset.echoId === e.id,
          );
          if (card) {
            card.scrollIntoView({ behavior: "smooth", block: "nearest" });
            card.focus({ preventScroll: true });
          }
        });
        pins.set(e.id, pin);
      }
      // Leaflet treats string tooltips as HTML: use a text-only DOM element.
      pin.setIcon(icon).bindTooltip(node("span", "", e.title));
    });
  }
  function render() {
    const activeId = document.activeElement?.dataset.echoId;
    const records = echoes
      .map((e) => ({ ...e, ...Core.discovery(e, fix) }))
      .sort(
        (a, b) =>
          (a.distance ?? Infinity) - (b.distance ?? Infinity) ||
          Date.parse(b.createdAt) - Date.parse(a.createdAt),
      );
    const unlocked = records.filter((e) => e.state === "unlocked");
    const newlyUnlocked = unlocked.filter((e) => !previousUnlocked.has(e.id));
    if (newlyUnlocked.length)
      $("announcement").textContent =
        newlyUnlocked.length +
        " Echo" +
        (newlyUnlocked.length === 1 ? " is" : "es are") +
        " now within reach.";
    previousUnlocked = new Set(unlocked.map((e) => e.id));
    $("echo-count").textContent = String(echoes.length);
    $("unlocked-count").textContent = String(unlocked.length);
    $("discovery-summary").textContent = Core.freshFix(fix)
      ? unlocked.length +
        " within reach · stories open inside 100 m with a reliable fix."
      : "Memories reveal themselves within 100 metres.";
    $("storage-note").textContent =
      storageProblem || "Saved on this device only · no shared memories yet";
    $("filter-all").setAttribute("aria-pressed", String(filter === "all"));
    $("filter-unlocked").setAttribute(
      "aria-pressed",
      String(filter === "unlocked"),
    );
    const list = $("echo-list");
    const scrollTop = list.scrollTop;
    list.replaceChildren();
    const visible = filter === "all" ? records : unlocked;
    if (!visible.length) {
      const empty = node("div", "empty");
      empty.append(
        node(
          "strong",
          "",
          echoes.length
            ? "Nothing within reach yet"
            : "A place for your first memory",
        ),
        node(
          "p",
          "",
          echoes.length
            ? "Enable GPS or move closer to an Echo. Switch to All Echoes to see where they are."
            : "Enable GPS, then leave an Echo here. Return to this place to rediscover it. Memories stay in this browser for now.",
        ),
      );
      list.append(empty);
    }
    visible.forEach((e) => {
      const card = node("button", "echo " + e.state);
      card.type = "button";
      card.dataset.echoId = e.id;
      const top = node("div", "echo-top");
      const labels = {
        unlocked: "● ECHO UNLOCKED",
        locked: "◇ LOCKED",
        uncertain: "◌ CHECKING GPS",
        unavailable: "◇ GPS REQUIRED",
      };
      top.append(
        node("span", "echo-tag", labels[e.state]),
        node(
          "span",
          "echo-distance",
          e.distance === null ? "—" : distanceLabel(e.distance),
        ),
      );
      const copy =
        e.state === "unlocked"
          ? e.story
          : e.state === "uncertain"
            ? "You’re nearby, but GPS uncertainty crosses the 100 m boundary. Wait for a more accurate fix or move closer."
            : e.state === "locked"
              ? "Get within 100 metres to reveal this memory."
              : "Enable GPS for a fresh location before revealing this memory.";
      card.append(
        top,
        node("h3", "", e.title),
        node("p", "", copy),
        node(
          "small",
          "",
          new Date(e.createdAt).toLocaleDateString(undefined, {
            year: "numeric",
            month: "short",
            day: "numeric",
          }),
        ),
      );
      card.addEventListener("click", () => {
        if (map) {
          map.stop().flyTo([e.lat, e.lng], 17, { animate: !reducedMotion });
          pins.get(e.id)?.openTooltip();
        }
      });
      list.append(card);
      if (e.id === activeId) card.focus({ preventScroll: true });
    });
    list.scrollTop = scrollTop;
    updatePins(records);
    const canSave = Core.canCreate(fix) && !storageProblem;
    $("create").disabled = !canSave;
    $("create-hint").textContent = storageProblem
      ? "Browser storage needs attention before a memory can be saved."
      : !Core.freshFix(fix)
        ? "Enable GPS to leave an Echo at your current location."
        : !Core.canCreate(fix)
          ? "GPS is too imprecise. Try an open area and wait for a better fix."
          : "Your memory will be pinned to your GPS location when you save.";
    if ($("dialog").open)
      $("save-location").textContent = canSave
        ? "Save location: " +
          fix.lat.toFixed(5) +
          ", " +
          fix.lng.toFixed(5) +
          " · accuracy ±" +
          Math.round(fix.accuracy) +
          " m. This updates as you move."
        : "A fresh, accurate location is required to save. Your draft is still here.";
  }
  function status(title, subtitle, online = false) {
    $("location-status").textContent = title;
    $("location-subtitle").textContent = subtitle;
    $("status-dot").classList.toggle("online", online);
  }
  function clearWatch() {
    generation++;
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    clearTimeout(expiryTimer);
    expiryTimer = null;
  }
  function invalidateFix() {
    fix = null;
    clearUserLocation();
    $("fix-age").textContent =
      "No current GPS fix. Memories remain on this device.";
  }
  function gpsSuccess(result) {
    const next = {
      lat: result.coords.latitude,
      lng: result.coords.longitude,
      accuracy: result.coords.accuracy,
      timestamp: result.timestamp,
    };
    if (!Core.freshFix(next)) {
      invalidateFix();
      status(
        "Waiting for a fresh location",
        "An old or invalid GPS reading was ignored.",
      );
      render();
      return;
    }
    fix = next;
    clearTimeout(expiryTimer);
    expiryTimer = setTimeout(
      () => {
        invalidateFix();
        $("locate").textContent = "Refresh GPS";
        status(
          "Location needs refreshing",
          "Your last fix is over 30 seconds old. Tracking is still waiting for GPS.",
        );
        render();
      },
      Math.max(0, Core.MAX_FIX_AGE - (Date.now() - fix.timestamp)),
    );
    status(
      Core.canCreate(fix)
        ? "Your location is active"
        : "Improving GPS accuracy",
      "GPS accuracy ±" + Math.round(fix.accuracy) + " m",
      Core.canCreate(fix),
    );
    $("fix-age").textContent =
      "Last fix " +
      new Date(fix.timestamp).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    $("locate").textContent = "Recenter";
    updateUserLocation();
    render();
  }
  function gpsFailure(err) {
    // Temporary unavailability/timeouts can be followed by a good reading on the
    // same watcher. Permission denial is terminal and releases the subscription.
    if (err.code === 1 || err.code === 0) clearWatch();
    else {
      clearTimeout(expiryTimer);
      expiryTimer = null;
    }
    invalidateFix();
    $("stop").hidden = watchId === null;
    $("locate").textContent = "Retry GPS";
    const messages = {
      1: "Allow location in your browser’s site settings, then retry.",
      2: "Check device location settings or try an open area, then retry.",
      3: "GPS timed out. Try an open area and retry.",
    };
    status(
      err.code === 1 ? "Location permission denied" : "Location unavailable",
      messages[err.code] ||
        "GPS could not start. Check browser permissions and retry.",
    );
    render();
  }
  function locate() {
    if (!navigator.geolocation) {
      status("GPS unavailable", "This browser does not support location.");
      return;
    }
    if (!window.isSecureContext) {
      status(
        "Secure connection required",
        "Open Urban Echo over HTTPS or localhost to enable GPS.",
      );
      return;
    }
    if (watchId !== null && Core.freshFix(fix)) {
      if (map)
        map.stop().flyTo([fix.lat, fix.lng], 16, { animate: !reducedMotion });
      return;
    }
    // Retrying always cancels the previous subscription, including after errors.
    clearWatch();
    invalidateFix();
    followNextFix = true;
    status(
      "Finding your location…",
      "Allow location when your browser asks. An accurate fix may take a moment.",
    );
    $("locate").textContent = "Retry GPS";
    $("stop").hidden = false;
    render();
    const token = generation;
    try {
      watchId = navigator.geolocation.watchPosition(
        (result) => {
          if (token === generation) gpsSuccess(result);
        },
        (err) => {
          if (token === generation) gpsFailure(err);
        },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
      );
    } catch {
      gpsFailure({ code: 0 });
    }
  }
  function stopTracking() {
    clearWatch();
    invalidateFix();
    $("stop").hidden = true;
    $("locate").textContent = "Enable GPS";
    status(
      "Tracking is off",
      "Enable location when you’re ready to explore again.",
    );
    render();
  }
  $("locate").addEventListener("click", locate);
  $("stop").addEventListener("click", stopTracking);
  $("recenter").addEventListener("click", locate);
  $("filter-all").addEventListener("click", () => {
    filter = "all";
    render();
  });
  $("filter-unlocked").addEventListener("click", () => {
    filter = "unlocked";
    render();
  });
  $("create").addEventListener("click", () => {
    if (Core.canCreate(fix) && !storageProblem) {
      $("form-error").textContent = "";
      $("dialog").showModal();
      render();
    }
  });
  $("close").addEventListener("click", () => $("dialog").close());
  $("echo-form").addEventListener("submit", (event) => {
    event.preventDefault();
    $("form-error").textContent = "";
    const title = $("title").value.trim(),
      story = $("story").value.trim();
    if (!Core.canCreate(fix)) {
      $("form-error").textContent =
        "A fresh GPS fix with accuracy within 100 m is required. Your draft has not been cleared.";
      return;
    }
    if (!title || !story || title.length > 65 || story.length > 1200) {
      $("form-error").textContent =
        "Please provide a title (up to 65 characters) and a memory (up to 1,200).";
      return;
    }
    // Re-read before writing so another tab’s new memories are preserved.
    readEchoes();
    if (storageProblem) {
      $("form-error").textContent = storageProblem;
      render();
      return;
    }
    const item = {
      id: crypto.randomUUID
        ? crypto.randomUUID()
        : Date.now() + "-" + Math.random().toString(36).slice(2),
      title,
      story,
      lat: fix.lat,
      lng: fix.lng,
      createdAt: new Date().toISOString(),
    };
    const next = [item, ...echoes];
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      $("form-error").textContent =
        "Browser storage is unavailable or full. Your Echo was not saved; your draft is still here.";
      return;
    }
    echoes = next;
    $("echo-form").reset();
    $("dialog").close();
    render();
    $("announcement").textContent =
      "Echo saved on this device at your current GPS location.";
  });
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY || event.key === null) {
      readEchoes();
      render();
    }
  });
  window.addEventListener("pagehide", stopTracking);
  // A suspended tab must not keep a stale story visible when reopened.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && fix && !Core.freshFix(fix)) {
      invalidateFix();
      status("Location needs refreshing", "Waiting for a fresh GPS fix.");
      render();
    }
  });
  initMap();
  readEchoes();
  render();
})();
