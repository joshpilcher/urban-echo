(() => {
  "use strict";
  const Core = window.EchoCore,
    Media = window.EchoMedia,
    Cloud = window.EchoCloud;
  const reducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;
  const STORAGE_KEY = "urban-echo-v1";
  const $ = (id) => document.getElementById(id);
  const pins = new Map(),
    photos = new Map();
  let map = null,
    userPin = null,
    accuracyCircle = null,
    miniMap = null,
    miniPin = null;
  let fix = null,
    watchId = null,
    generation = 0,
    expiryTimer = null;
  let autoLocationDetails = false;
  let echoes = [],
    sharedEchoes = [],
    storageProblem = "",
    filter = "all",
    kind = "all",
    mineOnly = false;
  let selectedId = null,
    confirmationId = null,
    previousUnlocked = new Set(),
    followNextFix = true;
  let photoBlob = null,
    photoPreviewURL = null,
    photoGeneration = 0,
    preparingPhoto = false;
  let saving = false,
    deleting = false,
    draftId = null,
    loadingShared = false,
    sharedError = "",
    toastTimer;
  function node(type, className, text) {
    const el = document.createElement(type);
    if (className) el.className = className;
    if (text != null) el.textContent = text;
    return el;
  }
  function icon(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"),
      use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    svg.classList.add("icon");
    svg.setAttribute("aria-hidden", "true");
    use.setAttribute("href", "#icon-" + name);
    svg.append(use);
    return svg;
  }
  function toast(message) {
    clearTimeout(toastTimer);
    $("toast").textContent = message;
    $("toast").hidden = false;
    toastTimer = setTimeout(() => ($("toast").hidden = true), 5000);
  }
  function mapNotice(message) {
    $("map-notice").textContent = message;
    $("map-notice").hidden = !message;
  }
  function tileLayer(target) {
    return L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(target);
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
    }).setView([-26.65, 153.07], 13);
    L.control.zoom({ position: "bottomleft" }).addTo(map);
    const tiles = tileLayer(map);
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
      const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
      if (!Array.isArray(data)) throw new Error();
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
    const p = [fix.lat, fix.lng];
    if (userPin) userPin.setLatLng(p);
    else
      userPin = L.marker(p, {
        icon: L.divIcon({
          className: "",
          html: '<span class="user-marker"></span>',
          iconSize: [18, 18],
        }),
      })
        .addTo(map)
        .bindTooltip("Your location");
    if (accuracyCircle) accuracyCircle.setLatLng(p).setRadius(fix.accuracy);
    else
      accuracyCircle = L.circle(p, {
        radius: fix.accuracy,
        color: "#4b95e8",
        weight: 1,
        fillOpacity: 0.08,
      }).addTo(map);
    if (followNextFix) {
      map.setView(p, 17);
      followNextFix = false;
    }
  }
  function allRecords() {
    const sharedIds = new Set(sharedEchoes.map((e) => e.id));
    return [...echoes.filter((e) => !sharedIds.has(e.id)), ...sharedEchoes]
      .map((e) => ({ ...e, ...Core.discovery(e, fix) }))
      .sort(
        (a, b) =>
          (a.distance ?? Infinity) - (b.distance ?? Infinity) ||
          Date.parse(b.createdAt) - Date.parse(a.createdAt),
      );
  }
  function hasPhoto(e) {
    return !!(e.photoId || e.photoPath);
  }
  function owner(e) {
    return e.source !== "shared" || e.ownerId === Cloud.userId;
  }
  function photoKey(e) {
    return (
      (e.source || "local") +
      ":" +
      e.id +
      ":" +
      (e.photoPath || e.photoId || "")
    );
  }
  function photoURL(e) {
    if (!hasPhoto(e)) return null;
    if (e.source === "shared") return Cloud.photoURL(e);
    const key = photoKey(e);
    if (photos.has(key)) return photos.get(key).url;
    const entry = { url: null, ready: false };
    photos.set(key, entry);
    Media.get(e.photoId)
      .then((blob) => {
        if (photos.get(key) !== entry) return;
        if (blob) {
          entry.url = URL.createObjectURL(blob);
        }
        entry.ready = true;
        render();
      })
      .catch(() => {
        entry.ready = true;
        render();
      });
    return null;
  }
  function lockedCopy(e) {
    return e.state === "uncertain"
      ? "You’re nearby. Wait for a clearer GPS reading or move closer to reveal this memory."
      : e.state === "locked"
        ? "Get within 100 metres to reveal this memory."
        : "Enable GPS for a fresh location before revealing this memory.";
  }
  function stateLabel(e) {
    return {
      unlocked: "ECHO UNLOCKED",
      locked: "LOCKED",
      uncertain: "CHECKING GPS",
      unavailable: "GPS REQUIRED",
    }[e.state];
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
      const content = node(
        "span",
        "echo-marker " + (e.state === "unlocked" ? "is-unlocked" : "is-locked"),
      );
      const url = e.state === "unlocked" ? photoURL(e) : null;
      if (url) {
        const image = node("img");
        image.src = url;
        image.alt = "";
        content.append(image);
      } else content.append(icon(hasPhoto(e) ? "camera" : "story"));
      const markerIcon = L.divIcon({
        className: "",
        html: content,
        iconSize: [38, 38],
        iconAnchor: [19, 38],
      });
      let pin = pins.get(e.id);
      if (!pin) {
        pin = L.marker([e.lat, e.lng], {
          icon: markerIcon,
          title: e.title,
        }).addTo(map);
        pin.on("click", () => openDetail(e.id));
        pins.set(e.id, pin);
      } else pin.setIcon(markerIcon);
      pin.bindTooltip(node("span", "", e.title));
    });
  }
  function drawDetail() {
    if (!$("detail-dialog").open) return;
    const e = allRecords().find((e) => e.id === selectedId);
    if (!e) {
      $("detail-dialog").close();
      return;
    }
    $("detail-title").textContent = e.title;
    $("detail-state").textContent = stateLabel(e);
    $("detail-distance").textContent =
      e.distance === null
        ? "GPS required"
        : distanceLabel(e.distance) + " away";
    $("detail-visibility").textContent =
      e.source === "shared" ? "Public Echo" : "Only this device";
    $("detail-story").textContent =
      e.state === "unlocked" ? e.story : lockedCopy(e);
    $("detail-date").textContent = new Date(e.createdAt).toLocaleDateString(
      undefined,
      { year: "numeric", month: "long", day: "numeric" },
    );
    const imageArea = $("detail-image");
    imageArea.replaceChildren();
    const url = e.state === "unlocked" ? photoURL(e) : null;
    if (url) {
      const image = node("img");
      image.src = url;
      image.alt = "Photo attached to “" + e.title + "”";
      imageArea.append(image);
    } else
      imageArea.append(
        icon(
          e.state === "unlocked" ? (hasPhoto(e) ? "camera" : "story") : "lock",
        ),
      );
    $("detail-notice").textContent =
      e.source === "shared"
        ? "A memory shared with everyone. In-app discovery opens within 100 metres; public content is not private."
        : "This memory and photo stay in this browser. They are not shared with other people.";
    $("delete-echo").hidden = !owner(e) || confirmationId === e.id;
    $("delete-confirm").hidden = confirmationId !== e.id || !owner(e);
    $("detail-close").disabled = deleting;
    $("delete-yes").disabled = deleting;
    $("delete-no").disabled = deleting;
  }
  function openDetail(id) {
    selectedId = id;
    confirmationId = null;
    $("detail-error").textContent = "";
    if (!$("detail-dialog").open) $("detail-dialog").showModal();
    drawDetail();
    const e = allRecords().find((e) => e.id === id);
    if (map && e) {
      map.stop().flyTo([e.lat, e.lng], 17, { animate: !reducedMotion });
      pins.get(id)?.openTooltip();
    }
  }
  function updateForm() {
    $("title-count").textContent = $("title").value.length + " / 65";
    $("story-count").textContent = $("story").value.length + " / 1,200";
    const isPublic = $("visibility-public").checked;
    $("visibility-public").disabled = !Cloud.available || saving;
    $("sharing-explanation").textContent = isPublic
      ? "Your title, story, photo and exact pin will be public. Keep this browser to manage your shared Echoes; this prototype has no account recovery."
      : "Your story, photo and exact pin stay in this browser.";
    $("save-echo").textContent = saving
      ? isPublic
        ? "Sharing your Echo…"
        : "Saving your Echo…"
      : isPublic
        ? "Share my Echo"
        : "Save my Echo";
    $("save-echo").disabled = saving || preparingPhoto;
    $("title").disabled = saving;
    $("story").disabled = saving;
    $("visibility-local").disabled = saving;
    $("close").disabled = saving;
    $("photo").disabled = saving;
    $("photo-remove").disabled = saving;
    if (!$("dialog").open) return;
    const ready = Core.canCreate(fix);
    $("location-badge").textContent = ready
      ? "At your location"
      : "GPS required";
    $("save-location").textContent = ready
      ? "Save location: " +
        fix.lat.toFixed(5) +
        ", " +
        fix.lng.toFixed(5) +
        " · accuracy ±" +
        Math.round(fix.accuracy) +
        " m. This updates as you move."
      : "A fresh, accurate location is required to save. Your draft is still here.";
    $("save-map").hidden = !ready || !window.L;
    if (ready && window.L) {
      const p = [fix.lat, fix.lng];
      if (!miniMap) {
        miniMap = L.map("save-map", {
          zoomControl: false,
          dragging: false,
          scrollWheelZoom: false,
          doubleClickZoom: false,
          touchZoom: false,
          zoomAnimation: false,
          fadeAnimation: false,
        });
        tileLayer(miniMap);
        miniPin = L.marker(p, {
          icon: L.divIcon({
            className: "",
            html: '<span class="preview-user-marker"></span>',
            iconSize: [18, 18],
          }),
        }).addTo(miniMap);
      }
      miniMap.setView(p, 16, { animate: false });
      miniPin.setLatLng(p);
      requestAnimationFrame(() => miniMap.invalidateSize({ animate: false }));
    }
  }
  function render() {
    const records = allRecords(),
      unlocked = records.filter((e) => e.state === "unlocked"),
      activeId = document.activeElement?.dataset.echoId;
    const newlyUnlocked = unlocked.filter((e) => !previousUnlocked.has(e.id));
    if (newlyUnlocked.length)
      $("announcement").textContent =
        newlyUnlocked.length +
        " Echo" +
        (newlyUnlocked.length === 1 ? " is" : "es are") +
        " now within reach.";
    previousUnlocked = new Set(unlocked.map((e) => e.id));
    const query = $("search").value.trim().toLocaleLowerCase();
    const filtered = records.filter(
      (e) =>
        (!mineOnly || owner(e)) &&
        (kind === "all" || (kind === "photo" ? hasPhoto(e) : !hasPhoto(e))) &&
        (!query || e.title.toLocaleLowerCase().includes(query)),
    );
    const visible =
      filter === "unlocked"
        ? filtered.filter((e) => e.state === "unlocked")
        : filtered;
    $("echo-count").textContent = String(filtered.length);
    $("unlocked-count").textContent = String(
      filtered.filter((e) => e.state === "unlocked").length,
    );
    $("list-eyebrow").textContent = mineOnly ? "YOUR PLACES" : "DISCOVER";
    $("list-heading").textContent = mineOnly ? "My Echoes" : "Nearby Echoes";
    $("discovery-summary").textContent = Core.freshFix(fix)
      ? unlocked.length + " within reach · walk closer to discover a story."
      : "Be here to discover what happened here.";
    $("storage-note").textContent =
      storageProblem ||
      (Cloud.available
        ? "Public Echoes are shared. Device-only memories stay private."
        : "Saved on this device only · public sharing is being connected.");
    $("filter-all").setAttribute("aria-pressed", String(filter === "all"));
    $("filter-unlocked").setAttribute(
      "aria-pressed",
      String(filter === "unlocked"),
    );
    document
      .querySelectorAll("[data-kind]")
      .forEach((button) =>
        button.setAttribute(
          "aria-pressed",
          String(button.dataset.kind === kind),
        ),
      );
    const list = $("echo-list"),
      scroll = list.scrollTop;
    list.replaceChildren();
    if (!visible.length) {
      const empty = node("div", "empty");
      empty.append(
        node(
          "strong",
          "",
          records.length
            ? "No memories in this view"
            : "A place for your first memory",
        ),
        node(
          "p",
          "",
          records.length
            ? "Try another filter, enable GPS or move closer to an Echo."
            : "Enable GPS, then leave a story or photo at this place. Return here to rediscover it.",
        ),
      );
      list.append(empty);
    }
    visible.forEach((e) => {
      const card = node(
        "button",
        "echo " + e.state + (e.id === selectedId ? " selected" : ""),
      );
      card.type = "button";
      card.dataset.echoId = e.id;
      const visual = node("div", "echo-visual"),
        url = e.state === "unlocked" ? photoURL(e) : null;
      if (url) {
        const image = node("img");
        image.src = url;
        image.alt = "";
        image.loading = "lazy";
        visual.append(image);
      } else
        visual.append(
          icon(
            e.state === "unlocked"
              ? hasPhoto(e)
                ? "camera"
                : "story"
              : "lock",
          ),
        );
      const copy = node("div", "echo-copy"),
        top = node("div", "echo-top");
      top.append(
        node("span", "echo-tag", stateLabel(e)),
        node(
          "span",
          "echo-distance",
          e.distance === null ? "GPS required" : distanceLabel(e.distance),
        ),
      );
      copy.append(
        top,
        node("h3", "", e.title),
        node("p", "", e.state === "unlocked" ? e.story : lockedCopy(e)),
        node(
          "small",
          "",
          (hasPhoto(e) ? "Photo memory" : "Written memory") +
            " · " +
            (e.source === "shared" ? "Public" : "This device"),
        ),
      );
      card.append(visual, copy);
      card.addEventListener("click", () => openDetail(e.id));
      list.append(card);
      if (activeId === e.id) card.focus({ preventScroll: true });
    });
    list.scrollTop = scroll;
    updatePins(filtered);
    $("create").disabled = !Core.canCreate(fix) || !!storageProblem || saving;
    $("create-hint").textContent = storageProblem
      ? "Browser storage needs attention before saving."
      : !Core.freshFix(fix)
        ? "Enable GPS to leave a memory where you are."
        : !Core.canCreate(fix)
          ? "Wait for a clearer GPS reading before leaving an Echo."
          : "A memory for the place where you’re standing.";
    drawDetail();
    updateForm();
  }
  async function refreshShared() {
    if (!Cloud.available) {
      $("community-status").textContent = "Memories on this device";
      return;
    }
    if (loadingShared) return;
    loadingShared = true;
    $("refresh-shared").disabled = true;
    $("community-status").textContent = "Finding shared Echoes…";
    try {
      sharedEchoes = await Cloud.load();
      sharedError = "";
    } catch (error) {
      sharedError = error.message;
    } finally {
      loadingShared = false;
      $("refresh-shared").disabled = false;
      $("community-status").textContent = sharedError
        ? "Shared memories unavailable"
        : sharedEchoes.length +
          " community Echo" +
          (sharedEchoes.length === 1 ? "" : "es");
      render();
    }
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
    if (autoLocationDetails) showLocationDetails(false);

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
    $("locate").textContent = window.matchMedia("(max-width: 900px)").matches
      ? Core.canCreate(fix)
        ? "GPS active"
        : "GPS accuracy"
      : "Recenter";
    updateUserLocation();
    render();
  }
  function gpsFailure(err) {
    if (window.matchMedia("(max-width: 900px)").matches)
      showLocationDetails(true, true);
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
        map.stop().flyTo([fix.lat, fix.lng], 17, { animate: !reducedMotion });
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
    showLocationDetails(false);
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
  function openCreate() {
    if (!Core.canCreate(fix)) {
      toast("Enable GPS and wait for an accurate location to create an Echo.");
      locate();
      return;
    }
    if (storageProblem) {
      toast("Browser storage needs attention before saving.");
      return;
    }
    $("form-error").textContent = "";
    if (!draftId) draftId = crypto.randomUUID();
    $("dialog").showModal();
    updateForm();
  }
  function clearPhoto() {
    photoGeneration++;
    photoBlob = null;
    preparingPhoto = false;
    $("photo").value = "";
    $("photo-preview").hidden = true;
    $("photo-status").textContent = "";
    $("photo-preview-image").removeAttribute("src");
    if (photoPreviewURL) URL.revokeObjectURL(photoPreviewURL);
    photoPreviewURL = null;
    updateForm();
  }
  $("photo").addEventListener("change", async () => {
    const file = $("photo").files?.[0];
    if (!file) return;
    const token = ++photoGeneration;
    photoBlob = null;
    preparingPhoto = true;
    $("photo-preview").hidden = true;
    $("photo-status").textContent = "Preparing your photo…";
    $("form-error").textContent = "";
    updateForm();
    try {
      const blob = await Media.prepare(file);
      if (token !== photoGeneration) return;
      photoBlob = blob;
      if (photoPreviewURL) URL.revokeObjectURL(photoPreviewURL);
      photoPreviewURL = URL.createObjectURL(blob);
      $("photo-preview-image").src = photoPreviewURL;
      $("photo-preview").hidden = false;
      $("photo-status").textContent =
        "Photo ready · " +
        Math.max(1, Math.round(blob.size / 1024)) +
        " KB. Original photo metadata is not retained.";
    } catch (error) {
      if (token !== photoGeneration) return;
      $("photo-status").textContent = error.message;
      $("photo").value = "";
    } finally {
      if (token === photoGeneration) {
        preparingPhoto = false;
        updateForm();
      }
    }
  });
  $("photo-remove").addEventListener("click", clearPhoto);
  $("title").addEventListener("input", updateForm);
  $("story").addEventListener("input", updateForm);
  document
    .querySelectorAll('input[name="visibility"]')
    .forEach((input) => input.addEventListener("change", updateForm));
  function showLocationDetails(open, automatic = false) {
    autoLocationDetails = open && automatic;
    document.querySelector(".location-panel").classList.toggle("is-open", open);
    $("locate").setAttribute("aria-expanded", String(open));
  }
  $("locate").addEventListener("click", () => {
    if (window.matchMedia("(max-width: 900px)").matches && Core.freshFix(fix)) {
      showLocationDetails(
        !document
          .querySelector(".location-panel")
          .classList.contains("is-open"),
      );
    } else locate();
  });
  $("location-close").addEventListener("click", () =>
    showLocationDetails(false),
  );
  $("stop").addEventListener("click", stopTracking);
  $("recenter").addEventListener("click", locate);
  $("create").addEventListener("click", openCreate);
  $("nav-create").addEventListener("click", openCreate);
  $("close").addEventListener("click", () => $("dialog").close());
  $("dialog").addEventListener("cancel", (event) => {
    if (saving) event.preventDefault();
  });
  $("detail-close").addEventListener("click", () => $("detail-dialog").close());
  $("detail-dialog").addEventListener("cancel", (event) => {
    if (deleting) event.preventDefault();
  });
  $("filter-all").addEventListener("click", () => {
    filter = "all";
    render();
  });
  $("filter-unlocked").addEventListener("click", () => {
    filter = "unlocked";
    render();
  });
  document.querySelectorAll("[data-kind]").forEach((button) =>
    button.addEventListener("click", () => {
      kind = button.dataset.kind;
      render();
    }),
  );
  function navigation(id, expanded, mine = false) {
    mineOnly = mine;
    $("discovery").classList.toggle("is-expanded", expanded);
    $("sheet-label").textContent = expanded ? "Show map" : "View list";
    $("sheet-toggle").setAttribute("aria-expanded", String(expanded));
    $("sheet-toggle").setAttribute(
      "aria-label",
      expanded ? "Collapse nearby memories" : "Expand nearby memories",
    );
    document.querySelectorAll(".bottom-nav button").forEach((b) => {
      if (b.id === id) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    });
    render();
  }
  document.querySelector(".skip-link").addEventListener("click", (event) => {
    event.preventDefault();
    navigation("nav-nearby", true);
    $("discovery").focus({ preventScroll: true });
  });
  $("nav-map").addEventListener("click", () => navigation("nav-map", false));
  $("nav-nearby").addEventListener("click", () =>
    navigation("nav-nearby", true),
  );
  $("nav-mine").addEventListener("click", () =>
    navigation("nav-mine", true, true),
  );
  $("sheet-toggle").addEventListener("click", () => {
    const expanded = !$("discovery").classList.contains("is-expanded");
    navigation(
      expanded ? (mineOnly ? "nav-mine" : "nav-nearby") : "nav-map",
      expanded,
      expanded && mineOnly,
    );
  });
  $("search-toggle").addEventListener("click", () => {
    const opening = $("search-bar").hidden;
    $("search-bar").hidden = !opening;
    $("search-toggle").setAttribute("aria-expanded", String(opening));
    if (opening) $("search").focus();
    else {
      $("search").value = "";
      render();
    }
  });
  $("search").addEventListener("input", render);
  $("clear-search").addEventListener("click", () => {
    $("search").value = "";
    render();
    $("search").focus();
  });
  $("refresh-shared").hidden = !Cloud.available;
  $("refresh-shared").addEventListener("click", async () => {
    await refreshShared();
    if (sharedError) toast(sharedError);
  });
  $("echo-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (saving || preparingPhoto) return;
    $("form-error").textContent = "";
    if (!Core.canCreate(fix)) {
      $("form-error").textContent =
        "A fresh GPS fix with accuracy within 100 m is required. Your draft has not been cleared.";
      return;
    }
    const title = $("title").value.trim(),
      story = $("story").value.trim(),
      isPublic = $("visibility-public").checked;
    if (!title || !story || title.length > 65 || story.length > 1200) {
      $("form-error").textContent =
        "Please provide a title (up to 65 characters) and a memory (up to 1,200).";
      return;
    }
    const item = {
      id: draftId || crypto.randomUUID(),
      title,
      story,
      lat: fix.lat,
      lng: fix.lng,
      createdAt: new Date().toISOString(),
    };
    const selectedPhoto = photoBlob;
    let storedPhoto = false;
    saving = true;
    updateForm();
    try {
      if (isPublic) {
        const saved = await Cloud.create(item, selectedPhoto);
        sharedEchoes = [
          saved,
          ...sharedEchoes.filter((e) => e.id !== saved.id),
        ];
      } else {
        readEchoes();
        if (storageProblem) throw new Error(storageProblem);
        if (selectedPhoto) {
          await Media.put(item.id, selectedPhoto);
          item.photoId = item.id;
          storedPhoto = true;
        }
        const next = [item, ...echoes];
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        } catch {
          if (storedPhoto) await Media.remove(item.id).catch(() => {});
          throw new Error(
            "Browser storage is unavailable or full. Your Echo was not saved; your draft is still here.",
          );
        }
        echoes = next;
      }
      $("echo-form").reset();
      clearPhoto();
      draftId = null;
      $("dialog").close();
      mineOnly = false;
      filter = "all";
      kind = "all";
      $("search").value = "";
      toast(
        isPublic
          ? "Your Echo is shared. Other visitors can discover it here."
          : "Your Echo is saved on this device.",
      );
      $("announcement").textContent = isPublic
        ? "Public Echo shared at your GPS location."
        : "Echo saved on this device at your current GPS location.";
      if (isPublic)
        $("community-status").textContent =
          sharedEchoes.length +
          " community Echo" +
          (sharedEchoes.length === 1 ? "" : "es");
    } catch (error) {
      $("form-error").textContent =
        error.message ||
        "Your Echo could not be saved. Your draft is still here.";
    } finally {
      saving = false;
      render();
    }
  });
  $("delete-echo").addEventListener("click", () => {
    confirmationId = selectedId;
    drawDetail();
  });
  $("delete-no").addEventListener("click", () => {
    confirmationId = null;
    drawDetail();
  });
  $("delete-yes").addEventListener("click", async () => {
    const e = allRecords().find((e) => e.id === selectedId);
    if (!e || !owner(e) || deleting) return;
    deleting = true;
    $("detail-error").textContent = "";
    drawDetail();
    try {
      if (e.source === "shared") {
        await Cloud.remove(e);
        sharedEchoes = sharedEchoes.filter((item) => item.id !== e.id);
      } else {
        readEchoes();
        if (storageProblem) throw new Error(storageProblem);
        const next = echoes.filter((item) => item.id !== e.id);
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        } catch {
          throw new Error(
            "Your Echo could not be deleted from browser storage. Please retry.",
          );
        }
        echoes = next;
        if (e.photoId) await Media.remove(e.photoId).catch(() => {});
      }
      const cached = photos.get(photoKey(e));
      if (cached?.url) URL.revokeObjectURL(cached.url);
      photos.delete(photoKey(e));
      selectedId = confirmationId = null;
      $("detail-dialog").close();
      toast("Echo deleted.");
    } catch (error) {
      $("detail-error").textContent = error.message;
    } finally {
      deleting = false;
      render();
    }
  });
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY || event.key === null) {
      readEchoes();
      render();
    }
  });
  window.addEventListener("pagehide", () => {
    stopTracking();
    for (const entry of photos.values())
      if (entry.url) URL.revokeObjectURL(entry.url);
    photos.clear();
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) render();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      if (fix && !Core.freshFix(fix)) {
        invalidateFix();
        status("Location needs refreshing", "Waiting for a fresh GPS fix.");
        render();
      }
      if (Cloud.available) refreshShared();
    }
  });
  if (Cloud.available)
    setInterval(() => {
      if (!document.hidden) refreshShared();
    }, 60000);
  initMap();
  readEchoes();
  render();
  refreshShared();
})();
