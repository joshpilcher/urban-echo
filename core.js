/* Shared location rules; usable in the browser and Node tests without a map. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.EchoCore = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const RADIUS = 100;
  const MAX_FIX_AGE = 30000;
  function mediaInfo(mime = "") {
    const type = mime.split(";")[0].trim().toLowerCase();
    const formats = {
      "video/webm": ["video", "webm"],
      "video/mp4": ["video", "mp4"],
      "video/quicktime": ["video", "mov"],
      "audio/webm": ["audio", "webm"],
      "audio/mp4": ["audio", "mp4"],
      "audio/x-m4a": ["audio", "m4a"],
      "audio/mpeg": ["audio", "mp3"],
      "audio/wav": ["audio", "wav"],
      "audio/x-wav": ["audio", "wav"],
      "audio/ogg": ["audio", "ogg"],
    };
    const pair = formats[type];
    return pair
      ? {
          type,
          kind: pair[0],
          extension: pair[1],
          maxBytes: (pair[0] === "video" ? 20 : 8) * 1024 * 1024,
          maxSeconds: pair[0] === "video" ? 30 : 60,
        }
      : null;
  }
  function validCoordinates(p) {
    return (
      !!p &&
      Number.isFinite(p.lat) &&
      Math.abs(p.lat) <= 90 &&
      Number.isFinite(p.lng) &&
      Math.abs(p.lng) <= 180
    );
  }
  function metres(a, b) {
    const rad = Math.PI / 180;
    const h =
      Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 +
      Math.cos(a.lat * rad) *
        Math.cos(b.lat * rad) *
        Math.sin(((b.lng - a.lng) * rad) / 2) ** 2;
    return 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
  }
  function freshFix(fix, now = Date.now()) {
    return (
      validCoordinates(fix) &&
      Number.isFinite(fix.accuracy) &&
      fix.accuracy >= 0 &&
      Number.isFinite(fix.timestamp) &&
      now - fix.timestamp >= 0 &&
      now - fix.timestamp < MAX_FIX_AGE
    );
  }
  function canCreate(fix, now = Date.now()) {
    return freshFix(fix, now) && fix.accuracy <= RADIUS;
  }
  function discovery(echo, fix, now = Date.now()) {
    if (!freshFix(fix, now)) return { state: "unavailable", distance: null };
    const distance = metres(fix, echo);
    // The reported accuracy is an estimate, not proof of physical presence.
    const state =
      distance > RADIUS
        ? "locked"
        : distance + fix.accuracy <= RADIUS
          ? "unlocked"
          : "uncertain";
    return { state, distance };
  }
  function validEcho(e) {
    return (
      validCoordinates(e) &&
      ((e.mediaKind == null && !e.mediaId && !e.mediaPath) ||
        (["audio", "video"].includes(e.mediaKind) &&
          typeof (e.mediaId || e.mediaPath) === "string" &&
          (e.mediaId || e.mediaPath).length <= 240 &&
          !(e.photoId || e.photoPath))) &&
      typeof e.id === "string" &&
      e.id.length > 0 &&
      e.id.length <= 100 &&
      typeof e.title === "string" &&
      e.title.trim().length > 0 &&
      e.title.length <= 65 &&
      typeof e.story === "string" &&
      e.story.trim().length > 0 &&
      e.story.length <= 1200 &&
      typeof e.createdAt === "string" &&
      Number.isFinite(Date.parse(e.createdAt))
    );
  }
  return {
    mediaInfo,
    RADIUS,
    MAX_FIX_AGE,
    validCoordinates,
    metres,
    freshFix,
    canCreate,
    discovery,
    validEcho,
  };
});
