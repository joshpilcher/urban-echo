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
    mineOnly = false;
  let selectedId = null,
    confirmationId = null,
    previousUnlocked = new Set(),
    followNextFix = true;
  let draftAttachments = [],
    photoGeneration = 0,
    preparingPhoto = false,
    clipGeneration = 0,
    preparingClip = false;
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
  function cover(e) {
    const items = Core.attachments(e);
    return items.find((a) => a.kind === "photo") || items[0];
  }
  function hasPhoto(e) {
    return Core.attachments(e).some((a) => a.kind === "photo");
  }
  function mediaKind(e) {
    return cover(e)?.kind || "story";
  }
  function owner(e) {
    return e.source !== "shared" || e.ownerId === Cloud.userId;
  }
  function photoKey(e, a = cover(e)) {
    return (
      (e.source || "local") +
      ":" +
      e.id +
      ":" +
      (a?.id || "") +
      ":" +
      (a?.path || "")
    );
  }
  function attachmentURL(e, a = cover(e)) {
    if (!a) return null;
    if (e.source === "shared") return Cloud.attachmentURL(a);
    const key = photoKey(e, a);
    if (photos.has(key)) return photos.get(key).url;
    const entry = { url: null, ready: false };
    photos.set(key, entry);
    Media.get(a.id)
      .then((blob) => {
        if (photos.get(key) !== entry) return;
        if (blob) entry.url = URL.createObjectURL(blob);
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
      let pin = pins.get(e.id);
      let content = pin?.getElement()?.querySelector(".echo-marker");
      if (!content) {
        content = node("span", "echo-marker");
        const markerIcon = L.divIcon({className:"", html:content, iconSize:[44,44], iconAnchor:[22,41]});
        if (!pin) {
          pin = L.marker([e.lat,e.lng], {icon:markerIcon}).addTo(map);
          pin.on("click",()=>openDetail(e.id));
          pins.set(e.id,pin);
        } else pin.setIcon(markerIcon);
      }
      const presence = e.proximity || 0;
      content.className = "echo-marker is-" + e.state;
      content.dataset.proximity = presence.toFixed(3);
      content.style.setProperty("--echo-presence", presence.toFixed(3));
      content.style.setProperty("--echo-scale", (0.72 + presence * 0.38).toFixed(3));
      content.style.setProperty("--echo-opacity", (0.55 + presence * 0.45).toFixed(3));
      const url = e.state === "unlocked" && hasPhoto(e) ? attachmentURL(e) : null;
      const key = url || mediaKind(e);
      if (content.dataset.mediaKey !== key) {
        content.replaceChildren();
        if (url) {
          const image = node("img");image.src=url;image.alt="";content.append(image);
        } else content.append(icon(mediaKind(e) === "photo" ? "camera" : mediaKind(e)));
        content.dataset.mediaKey = key;
      }
      const label = e.title + ". " + stateLabel(e).toLowerCase().replaceAll("_"," ") +
        (e.distance === null ? "." : ". " + distanceLabel(e.distance) + " away.");
      pin.getElement()?.setAttribute("aria-label",label);
      pin.setZIndexOffset(Math.round(presence*200)+(e.state === "unlocked" ? 100 : 0));
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
    drawDetailMedia(e);
    window.EchoSocial.update(e);
    $("detail-notice").textContent =
      e.source === "shared"
        ? "A memory shared with everyone. In-app discovery opens within 100 metres; public content is not private."
        : "This memory and attachments stay in this browser. They are not shared with other people.";
    $("delete-echo").hidden = !owner(e) || confirmationId === e.id;
    $("delete-confirm").hidden = confirmationId !== e.id || !owner(e);
    $("detail-close").disabled = deleting;
    $("delete-yes").disabled = deleting;
    $("delete-no").disabled = deleting;
  }
  function drawDetailMedia(e) {
    const hero = $("detail-image"),
      audio = $("detail-audio"),
      items = Core.attachments(e);
    const unlocked = e.state === "unlocked",
      key = e.id + ":" + unlocked;
    if (hero.dataset.mediaKey !== key) {
      disposeAudioPlayers($("detail-dialog"));
      pausePlayers($("detail-dialog"));
      hero.replaceChildren();
      audio.replaceChildren();
      hero.dataset.mediaKey = key;
    }
    const visuals = items.filter((a) => a.kind !== "audio"),
      sounds = items.filter((a) => a.kind === "audio");
    $("detail-gallery").hidden = !unlocked || !visuals.length;
    audio.hidden = !unlocked || !sounds.length;
    if (!unlocked) return;
    function updateMedia(area, a, index) {
      const url = attachmentURL(e, a);
      if (url && area.dataset.url !== url) {
        disposeAudioPlayers(area);
        pausePlayers(area);
        area.replaceChildren();
        area.dataset.url = url;
        const player = node(a.kind === "photo" ? "img" : a.kind);
        if (a.kind === "photo")
          player.alt =
            "Photo " + (index + 1) + " attached to “" + e.title + "”";
        else {
          player.controls = true;
          player.preload = "metadata";
          player.setAttribute("playsinline", "");
          player.setAttribute(
            "aria-label",
            a.kind + " memory " + (index + 1) + ": " + e.title,
          );
          player.addEventListener("play", () => {
            $("detail-dialog")
              .querySelectorAll("audio,video")
              .forEach((other) => {
                if (other !== player) other.pause();
              });
          });
        }
        const feedback = node("p", "media-feedback");
        feedback.setAttribute("role", "status");
        player.addEventListener("error", () => {
          feedback.textContent =
            "This attachment could not load. Check your connection or try another browser.";
        });
        player.src = url;
        if (a.kind === "audio" && window.EchoAudio)
          area.append(
            window.EchoAudio.create(
              player,
              "audio memory " + (index + 1),
              feedback,
            ),
            feedback,
          );
        else area.append(player, feedback);
        if (a.kind === "video") window.EchoVideo?.preview(player);
      } else if (!url && !area.firstChild)
        area.append(node("p", "muted", "Loading attachment…"));
      if (!url && e.source !== "shared" && photos.get(photoKey(e, a))?.ready)
        area.textContent = "This attachment is unavailable in this browser.";
      return url;
    }
    visuals.forEach((a, index) => {
      let area = [...hero.children].find(
        (el) => el.dataset.attachmentId === a.id,
      );
      if (!area) {
        area = node("figure", "media-item full-media");
        area.dataset.attachmentId = a.id;
        hero.append(area);
      }
      area.hidden = false;
      updateMedia(area, a, index);
      if (!area.querySelector("figcaption"))
        area.append(
          node(
            "figcaption",
            "attachment-caption",
            (a.kind === "photo" ? "Photo " : "Video ") + (index + 1),
          ),
        );
    });
    $("detail-gallery-count").textContent =
      visuals.length + (visuals.length === 1 ? " moment" : " moments");
    sounds.forEach((a, index) => {
      let card = [...audio.children].find(
        (el) => el.dataset.attachmentId === a.id,
      );
      if (!card) {
        card = node("div", "audio-memory");
        card.dataset.attachmentId = a.id;
        const heading = node("div", "audio-heading");
        heading.append(
          icon("audio"),
          node(
            "strong",
            "",
            sounds.length === 1
              ? "Listen to this place"
              : "Audio memory " + (index + 1),
          ),
        );
        const playerArea = node("div", "audio-player");
        card.append(heading, playerArea);
        audio.append(card);
      }
      // Each audio memory stays compact and remains directly playable beneath the story.
      updateMedia(card.querySelector(".audio-player"), a, index);
    });
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
    }
  }
  function updateForm() {
    $("title-count").textContent = $("title").value.length + " / 65";
    $("story-count").textContent = $("story").value.length + " / 1,200";
    const isPublic = $("visibility-public").checked;
    $("visibility-public").disabled = !Cloud.available || saving;
    $("sharing-explanation").textContent = isPublic
      ? "Your title, story, attachments and exact pin will be public. Keep this browser to manage your shared Echoes; this prototype has no account recovery."
      : "Your story, attachments and exact pin stay in this browser.";
    $("save-echo").textContent = saving
      ? isPublic
        ? "Sharing your Echo…"
        : "Saving your Echo…"
      : isPublic
        ? "Share my Echo"
        : "Save my Echo";
    $("save-echo").disabled =
      saving || preparingPhoto || preparingClip || recorder.busy;
    $("title").disabled = saving;
    $("story").disabled = saving;
    $("visibility-local").disabled = saving;
    $("close").disabled = saving;
    $("photo").disabled =
      saving || preparingPhoto || preparingClip || recorder.busy;
    for (const id of [
      "record-video",
      "record-audio",
      "video-file",
      "audio-file",
    ])
      $(id).disabled =
        saving || preparingPhoto || preparingClip || recorder.busy;
    document.querySelectorAll("[data-remove-attachment]").forEach((button) => {
      button.disabled =
        saving || preparingPhoto || preparingClip || recorder.busy;
    });
    const full = draftAttachments.length >= Core.MAX_ATTACHMENTS;
    if (full)
      for (const id of [
        "photo",
        "record-video",
        "record-audio",
        "video-file",
        "audio-file",
      ])
        $(id).disabled = true;
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
    $("map-discovery-title").textContent = sharedError
      ? "Shared Echoes unavailable"
      : !Core.freshFix(fix)
        ? "Find a story nearby"
        : !Core.canCreate(fix)
          ? "Finding your place"
          : unlocked.length
            ? unlocked.length +
              " Echo" +
              (unlocked.length === 1 ? "" : "es") +
              " within reach"
            : "No Echoes within reach";
    $("map-discovery-copy").textContent = sharedError
      ? "Device memories still work. Use Refresh to retry."
      : !Core.freshFix(fix)
        ? "Enable GPS to discover memories around you."
        : !Core.canCreate(fix)
          ? "Wait for a clearer GPS reading to reveal memories."
          : unlocked.length
            ? "Bright teal pins are within reach. Tap to explore."
            : "Pins grow brighter as you get closer. Open Nearby to explore.";

    const query = $("search").value.trim().toLocaleLowerCase();
    const filtered = records.filter(
      (e) =>
        (!mineOnly || owner(e)) &&
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
        url =
          e.state === "unlocked"
            ? hasPhoto(e)
              ? attachmentURL(e)
              : null
            : null;
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
              ? mediaKind(e) === "photo"
                ? "camera"
                : mediaKind(e)
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
          (Core.attachments(e).length > 1
            ? Core.attachments(e).length +
              " attachments · " +
              [
                ...new Set(
                  Core.attachments(e).map(
                    (a) =>
                      ({ photo: "Photos", video: "Video", audio: "Audio" })[
                        a.kind
                      ],
                  ),
                ),
              ].join(", ")
            : {
                photo: "Photo memory",
                audio: "Audio memory",
                video: "Video memory",
                story: "Written memory",
              }[mediaKind(e)]) +
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
  function disposeAudioPlayers(area) {
    area.querySelectorAll("video").forEach(player => player.disposePreview?.());
    area
      .querySelectorAll(".echo-audio")
      .forEach((widget) => widget.dispose?.());
  }
  function pausePlayers(area) {
    area.querySelectorAll("audio,video").forEach((p) => p.pause());
  }
  function renderDraftAttachments() {
    for (const id of ["photo-items", "clip-player"]) {
      disposeAudioPlayers($(id));
      pausePlayers($(id));
      $(id).replaceChildren();
    }
    const totals = { photo: 0, audio: 0, video: 0 };
    for (const attachment of draftAttachments) {
      const { id, kind, url } = attachment;
      totals[kind]++;
      const area = node("figure", "draft-attachment");
      area.dataset.attachmentId = id;
      const player = node(kind === "photo" ? "img" : kind);
      player.src = url;
      if (kind === "photo") {
        player.alt = "Selected photo " + totals.photo;
        if (totals.photo === 1) player.id = "photo-preview-image";
      } else {
        player.controls = true;
        player.preload = "metadata";
        player.setAttribute("playsinline", "");
        player.setAttribute("aria-label", "Selected " + kind + " preview");
      }
      const remove = node(
        "button",
        "text-button",
        "Remove " + kind + " " + totals[kind],
      );
      remove.type = "button";
      remove.dataset.removeAttachment = id;
      if (kind === "photo" && totals.photo === 1) remove.id = "photo-remove";
      if (kind !== "photo" && !$("clip-player").children.length)
        remove.id = "clip-remove";
      remove.addEventListener("click", () => {
        disposeAudioPlayers(area);
        pausePlayers(area);
        URL.revokeObjectURL(url);
        draftAttachments = draftAttachments.filter((a) => a.id !== id);
        renderDraftAttachments();
        updateForm();
      });
      player.addEventListener("play", () => {
        $("clip-player").querySelectorAll("audio,video").forEach(other => {
          if (other !== player) other.pause();
        });
      });
      if (kind === "audio" && window.EchoAudio) {
        area.classList.add("audio-memory", "draft-audio");
        const heading = node("div", "audio-heading");
        heading.append(icon("audio"), node("strong", "", "Audio memory " + totals.audio));
        const feedback = node("p", "media-feedback");
        feedback.setAttribute("role", "status");
        area.append(heading, window.EchoAudio.create(player, "audio preview " + totals.audio, feedback), feedback, remove);
      } else area.append(player, remove);
      $(kind === "photo" ? "photo-items" : "clip-player").append(area);
      if (kind === "video") window.EchoVideo?.preview(player);
    }
    $("photo-preview").hidden = !totals.photo;
    $("clip-preview").hidden = !totals.audio && !totals.video;
    const size = draftAttachments.reduce((sum, a) => sum + a.blob.size, 0);
    $("attachment-summary").textContent =
      draftAttachments.length +
      " / " +
      Core.MAX_ATTACHMENTS +
      " attachments · " +
      (size / 1024 / 1024).toFixed(1) +
      " / 50 MB";
  }
  function addDraftAttachment(blob, kind) {
    if (draftAttachments.length >= Core.MAX_ATTACHMENTS)
      throw new Error(
        "You can add up to 8 attachments. Remove one to add another.",
      );
    if (
      draftAttachments.reduce((sum, a) => sum + a.blob.size, 0) + blob.size >
      Core.MAX_TOTAL_BYTES
    )
      throw new Error(
        "Attachments must total no more than 50 MB. Remove one or choose a smaller file.",
      );
    draftAttachments.push({
      id: crypto.randomUUID(),
      kind,
      blob,
      url: URL.createObjectURL(blob),
    });
    renderDraftAttachments();
  }
  function clearDraftAttachments() {
    photoGeneration++;
    clipGeneration++;
    preparingPhoto = preparingClip = false;
    draftAttachments.forEach((a) => URL.revokeObjectURL(a.url));
    draftAttachments = [];
    $("photo").value = $("video-file").value = $("audio-file").value = "";
    $("photo-status").textContent = $("clip-status").textContent = "";
    renderDraftAttachments();
    updateForm();
  }
  $("photo").addEventListener("change", async () => {
    const files = [...($("photo").files || [])];
    if (!files.length) return;
    const token = ++photoGeneration;
    preparingPhoto = true;
    $("photo-status").textContent = "Preparing your photos…";
    updateForm();
    const errors = [];
    try {
      for (const file of files) {
        if (token !== photoGeneration) return;
        try {
          const blob = await Media.prepare(file);
          if (token !== photoGeneration) return;
          addDraftAttachment(blob, "photo");
        } catch (error) {
          errors.push(error.message);
        }
      }
      if (token === photoGeneration)
        $("photo-status").textContent = errors.length
          ? errors.join(" ")
          : "Photos added. Original photo metadata is not retained.";
    } finally {
      if (token === photoGeneration) {
        preparingPhoto = false;
        $("photo").value = "";
        updateForm();
      }
    }
  });
  async function attachClip(file, kind, duration) {
    const token = ++clipGeneration;
    preparingClip = true;
    $("clip-status").textContent = "Checking " + (file.name || "your " + kind) + "…";
    updateForm();
    try {
      const blob = await Media.prepareClip(file, kind, duration);
      if (token !== clipGeneration) return;
      addDraftAttachment(blob, kind);
      $("clip-status").textContent =
        (kind === "audio" ? "Audio" : "Video") +
        " added. Preview before saving.";
      if ($("dialog").open) $("clip-preview").scrollIntoView({block:"nearest"});
    } catch (error) {
      if (token === clipGeneration)
        $("clip-status").textContent =
          error.message + " Your selected attachments are still here.";
      if (token === clipGeneration && $("dialog").open) $("clip-status").scrollIntoView({block:"nearest"});
    } finally {
      if (token === clipGeneration) {
        preparingClip = false;
        $(kind + "-file").value = "";
        updateForm();
      }
    }
  }
  let recorderState = "idle";
  const recorder = window.EchoRecorder.create({
    onState(state, data) {
      const changed = recorderState !== state;
      recorderState = state;
      $("recorder").hidden = state === "idle";
      $("recorder").dataset.state = state;
      if (changed && (state === "ready" || state === "recording"))
        requestAnimationFrame(() => {
          if ($("dialog").open && recorderState === state) {
            $(state === "ready" ? "record-start" : "record-stop").focus({ preventScroll: true });
            $("recorder").scrollIntoView({
              block: "nearest",
              behavior: "instant",
            });
          }
        });
      $("record-start").hidden = state !== "ready";
      $("record-stop").hidden = state !== "recording";
      const live = $("recording-live");
      live.hidden = !["ready", "recording"].includes(state) || data.kind !== "video";
      if (data.stream && live.srcObject !== data.stream) {
        live.srcObject = data.stream;
        live.play().catch(() => {});
      }
      if (state === "idle" || state === "processing") {
        live.pause();
        live.srcObject = null;
      }
      $("recording-status").textContent =
        state === "requesting"
          ? "Waiting for camera or microphone permission…"
          : state === "ready"
            ? (data.kind === "video" ? "Camera ready. Frame your shot, then tap Start recording." : "Microphone ready. Tap Start recording when you’re ready.")
          : state === "processing"
            ? "Finishing your recording…"
            : "Recording " +
              (data.kind || "") +
              " · " +
              (data.seconds || 0) +
              " / " +
              (data.limit || 0) +
              " seconds";
      updateForm();
    },
    onReady: attachClip,
    onError(error) {
      $("clip-status").textContent = error.message;
      updateForm();
    },
  });
  for (const kind of ["audio", "video"]) {
    $("record-" + kind).addEventListener("click", () => {
      pausePlayers($("clip-player"));
      $("clip-status").textContent = "";
      recorder.prepare(kind);
    });
    $(kind + "-file").addEventListener("change", async () => {
      const files = [...($(kind + "-file").files || [])];
      for (const file of files) await attachClip(file, kind);
    });
  }
  $("record-start").addEventListener("click", recorder.start);
  $("record-stop").addEventListener("click", recorder.stop);
  $("record-cancel").addEventListener("click", recorder.cancel);
  $("dialog").addEventListener("close", () => {
    recorder.cancel();
    pausePlayers($("clip-player"));
  });
  $("detail-dialog").addEventListener("close", () =>
    pausePlayers($("detail-dialog")),
  );
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
  $("detail-close").addEventListener("click", () => {
    pausePlayers($("detail-dialog"));
    $("detail-dialog").close();
  });
  $("detail-dialog").addEventListener("cancel", (event) => {
    if (deleting) event.preventDefault();
    else pausePlayers($("detail-dialog"));
  });
  $("filter-all").addEventListener("click", () => {
    filter = "all";
    render();
  });
  $("filter-unlocked").addEventListener("click", () => {
    filter = "unlocked";
    render();
  });
  function navigation(id, expanded, mine = false) {
    $("activity-view").hidden = id !== "nav-activity";
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
  $("map-discovery-link").addEventListener("click", () => {
    $("search").value = "";
    filter = allRecords().some((e) => e.state === "unlocked")
      ? "unlocked"
      : "all";
    navigation("nav-nearby", true);
  });
  const refreshActivity = () => window.EchoSocial.activity(async id => {
    let e = allRecords().find(item=>item.id===id);
    if (!e) {await refreshShared();e=allRecords().find(item=>item.id===id);}
    if(e) openDetail(id); else toast("This Echo is no longer available in the current collection.");
  });
  $("nav-activity").addEventListener("click",()=>{
    navigation("nav-activity",false);refreshActivity();$("activity-title").focus({preventScroll:true});
  });
  $("activity-refresh").addEventListener("click",refreshActivity);
  $("detail-dialog").addEventListener("close",()=>window.EchoSocial.update(null));
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
    if (saving || preparingPhoto || preparingClip || recorder.busy) return;
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
    const selectedAttachments = draftAttachments.map(({ id, kind, blob }) => ({
      id,
      kind,
      blob,
    }));
    const storedAttachments = [];
    saving = true;
    updateForm();
    try {
      if (isPublic) {
        const saved = await Cloud.createCollection(item, selectedAttachments);
        sharedEchoes = [
          saved,
          ...sharedEchoes.filter((e) => e.id !== saved.id),
        ];
      } else {
        readEchoes();
        if (storageProblem) throw new Error(storageProblem);
        try {
          item.attachments = [];
          for (const attachment of selectedAttachments) {
            await Media.put(attachment.id, attachment.blob);
            storedAttachments.push(attachment.id);
            item.attachments.push({ id: attachment.id, kind: attachment.kind });
          }
          const next = [item, ...echoes];
          localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
          echoes = next;
        } catch {
          await Promise.all(
            storedAttachments.map((id) => Media.remove(id).catch(() => {})),
          );
          throw new Error(
            "Browser storage is unavailable or full. Your Echo was not saved; your draft is still here.",
          );
        }
      }
      $("echo-form").reset();
      clearDraftAttachments();
      draftId = null;
      $("dialog").close();
      mineOnly = false;
      filter = "all";
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
        await Promise.all(
          Core.attachments(e).map((a) => Media.remove(a.id).catch(() => {})),
        );
      }
      for (const a of Core.attachments(e)) {
        const key = photoKey(e, a),
          cached = photos.get(key);
        if (cached?.url) URL.revokeObjectURL(cached.url);
        photos.delete(key);
      }
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
    recorder.cancel();
    disposeAudioPlayers($("clip-player"));
    pausePlayers($("clip-player"));
    disposeAudioPlayers($("detail-dialog"));
    pausePlayers($("detail-dialog"));
    stopTracking();
    for (const entry of photos.values())
      if (entry.url) URL.revokeObjectURL(entry.url);
    photos.clear();
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) render();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      recorder.cancel();
      pausePlayers($("clip-player"));
      pausePlayers($("detail-dialog"));
    }
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
  renderDraftAttachments();
  initMap();
  readEchoes();
  render();
  refreshShared();
})();
