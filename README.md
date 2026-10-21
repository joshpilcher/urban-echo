# Urban Echo

**[Open the live prototype](https://joshpilcher.github.io/urban-echo/)** · [Process journal](https://joshpilcher.github.io/urban-echo-process-journal/)

Location-responsive mobile web app · DES222 prototype v0.4

A location-responsive DES222 mobile web prototype. The map and distance-sorted memory cards respond to device location; stories reveal when the reported position and its accuracy estimate fit inside a 100 m discovery radius.

## Run

No build step is needed. Serve the repository root:

```sh
python3 -m http.server 8000
```

Use `http://localhost:8000/` on the same computer. A phone needs an **HTTPS** deployment; opening an HTTP LAN address usually cannot access geolocation. The app asks for location only after Enable GPS is pressed. It has no background tracking. Public media sharing uses a dedicated Supabase project; see [backend setup and limits](backend/README.md).

## Current behaviour

- One live geolocation watcher, cancelled on stop, permission denial, retry or page exit. Temporary GPS errors lock content but allow the current watcher to recover.
- Position fixes expire after 30 seconds. Refresh GPS restarts tracking if a stationary device stops delivering updates.
- Discovery states: GPS required; locked beyond 100 m; checking GPS if the accuracy estimate crosses the boundary; unlocked when distance + accuracy is at most 100 m.
- Memory creation requires a fresh fix with accuracy at most 100 m. Saving uses the latest GPS coordinates, never the map centre. The form shows the changing save location and preserves drafts after errors.
- Photos are validated (JPEG/PNG/WebP, up to 10 MB), resized to at most 1600 px, and re-encoded as JPEG without retaining original EXIF metadata. Device-only photos use IndexedDB; metadata remains small. Local photos and stories can be deleted from their detail view. Clearing site data removes device memories.
- The light map interface follows the Task 2 mock-up: serif headings, teal controls, full mobile Map and separate full-height Nearby list, photo detail view and a GPS preview during creation. Title search and the Nearby All/Within reach views work on actual saved records.
- Text memories persist under the original `urban-echo-v1` localStorage key. They remain on this browser/device only. Existing valid v0.1 records are retained. Invalid storage is not silently overwritten.
- Public Echoes appear for other visitors after Refresh (or the 60-second foreground refresh). Contributors use an anonymous session, with creator-only row/photo writes and deletion enforced by Supabase policies. Public explicitly shares exact coordinates and content; old device memories are never automatically uploaded.
- Local Leaflet 1.9.4 distribution and licence are in `vendor/leaflet/`. Basemap tiles still require an internet connection to OpenStreetMap. Fonts have system fallbacks. If the map script or tiles cannot load, the GPS/list workflow remains available.

The proximity check is a client-side prototype rule, not access control. All local story data can be inspected in browser storage. Location accuracy is an estimate. The 100 m radius and 30 s expiry are provisional design decisions awaiting field evaluation.

## Audio and video memories (v0.4.0)

Create supports one optional attachment: photo, video or audio. Record video (rear camera preferred, including microphone) up to 30 seconds / 20 MB, or audio up to 60 seconds / 8 MB. Explicit record buttons request permission; a live video preview/timer and Stop/Cancel controls remain available. The recorder selects a browser-supported MP4/WebM/Ogg format. Devices stop on completion, cancellation, interruption, dialog close, page hide and a late permission response after cancellation. Existing attachments remain until a replacement has prepared successfully.

An expandable file chooser provides MP4/WebM/QuickTime video and M4A/MP3/WAV/Ogg/WebM audio fallback. Files must pass type, size, readable duration and browser metadata checks; codec support still varies. There is no transcoding service. Imported files retain original metadata; photos retain their existing JPEG re-encoding. Add spoken words to the required story text for a readable alternative; automatic captions/transcription are not implemented.

Preview before saving. Device-only clips use the existing IndexedDB store (the legacy `photos` store name is retained for compatibility); only small metadata enters localStorage. Public clips use the separate `urban-echo-recordings` bucket. Echo details provide native playback controls without autoplay. GPS refreshes preserve playback; moving out of range, stopping GPS or closing details stops playback. Map/list show media icons and do not pre-download recordings. Public media URLs remain public, regardless of the in-app proximity state.

## Map-first mobile layout (v0.3.3)

The All/Photos/Stories toolbar is removed. A compact discovery card on Map shows real GPS-dependent nearby counts or an honest empty/uncertain state, and opens the matching Nearby view. Refresh shared Echoes remains available as an icon on that card. No example/public memories are inserted to fill empty space.

Map fills the mobile content area. Memories are in Nearby and My Echoes, rather than covering the map. Create floats at the bottom left, with recenter at the bottom right. The small GPS chip sits above Create and enables location; once a fresh fix is active, tapping it opens accuracy and Stop tracking controls. Location errors open the explanation automatically, and a good fix closes that automatic notice. The starting regional view uses zoom 13 (previously 12), and the first GPS view uses zoom 17 (previously 16). No location is requested on page load.

The larger text, 44 px controls, persistent detail close toolbar and complete mobile detail photo remain from v0.3.1. The creation dialog uses dynamic viewport height, scrollable content and a sticky close header; real iOS/Android keyboard and safe-area behaviour still require device testing.

## Automated checks

```sh
npm ci
npm test
npx playwright install chromium
npm run test:browser
# Optional: test the local workflow with all external network requests blocked
ECHO_TEST_OFFLINE=1 npm run test:browser
# Explicit live-service test: creates two anonymous sessions and deletes its test Echo/photo
npm run test:shared
# Synthetic camera/microphone + real browser encoding; device-only
npm run test:media
# Explicit real backend verification for audio/video (test rows/files removed)
npm run test:shared-media
```

Both browser runners start and stop their own local HTTP servers. The regular regression runner injects empty cloud configuration to keep its cases device-only; the separate shared runner uses the configured real Supabase service. `CHROMIUM_PATH` can select an existing Chromium executable. It uses `HTTPS_PROXY` when set. In this work environment the standard browser download was unavailable, so the checks used a separately installed Chromium 133 binary with Playwright 1.62.1. The binary is not part of this repository. That older browser also required `PW_TEST_SCREENSHOT_NO_FONTS_READY=1` for screenshot capture because its font-ready wait could stall; this affects the test capture only.

Twenty-three Node checks cover the location rules and shared-storage adapter contracts using a fake SDK. These do not validate live database policies. Twenty-one browser checks use synthetic coordinates/content and an overridden browser geolocation provider. They cover permissions/retry, temporary errors, creation, persistence, movement, uncertainty, stopping, stale fixes, storage failures, text-only tooltips, responsive sizing, map-script failure, photo validation/resizing, IndexedDB persistence, deletion and live photo relocking. Mobile checks also cover 320 × 568, 390 × 844, 430 × 932 and 844 × 390 viewports, reachable list cards and create/close controls, navigation state, title search and a reduced-height form viewport. These are browser layout simulations rather than physical keyboard or phone tests. Optional Google Fonts are disabled in the browser runner to make screenshot capture independent of that network service; the app’s system-font fallbacks are used. Screenshots are regenerated in `test-results/screenshots/` and visibly labelled **SIMULATED GPS · BROWSER TEST**. They do not prove actual phone GPS performance.

## Physical-phone test still needed

1. Open the HTTPS app in iOS Safari and/or Android Chrome. Record browser, phone, date and conditions.
2. Deny location, then allow it in site settings and retry. Note the observed permission workflow.
3. Outdoors, enable GPS and record the accuracy and time to first usable fix.
4. Create a memory; reload and check that it remains. Pan the map before saving another memory to confirm that creation uses GPS.
5. Walk far enough beyond the 100 m radius for the story to lock. Return and record the distances/accuracy at which it reopens, including any uncertainty state.
6. Remain still for over 30 s, then try Refresh GPS if the fix expires. Evaluate whether this policy interrupts normal reading too often.
7. Stop tracking. Check the user marker disappears and stories relock. Test portrait/landscape and the on-screen keyboard.
8. Capture real screenshots and a short screen recording. Add actual results to Task 3; do not replace browser evidence with a claim of field validation.

## Process journal and history

The assessment process journal, screenshots and development reflections remain in [urban-echo-process-journal](https://github.com/joshpilcher/urban-echo-process-journal). This repository contains the application and its tests. The original development history remains in the journal repository; see [MIGRATION.md](MIGRATION.md) for the source snapshot and changes made during separation.

Seven live shared-storage checks passed using two independent anonymous browser sessions: public reads without account creation, a failed insert with a preserved photo draft, real upload/contribution, second-session discovery and GPS relocking, RLS enforcement against unauthenticated and cross-user writes, and creator deletion after reload. The test Echo and photo were removed. The test uses synthetic coordinates and an image drawn on canvas; it does not establish outdoor GPS performance. Test anonymous Auth accounts remain; do not treat them as real participants.

## Next increments

Field-test the core loop and camera/photo flow on phones, review the 100 m / 30 s decisions, and record the required standalone 1–3 minute showreel. Anonymous ownership has no recovery after site data is cleared; moderation, account recovery and pagination beyond the newest 200 public Echoes remain future work. Anonymous sign-up keeps the service's default rate limits; CAPTCHA abuse protection is not configured for the prototype.

The media browser runner uses Chromium’s synthetic camera/microphone with the real MediaRecorder API. Local checks cover permission denial, unavailable recording, camera close cleanup, file validation/duration, responsive removal controls, audio/video recording and preview, IndexedDB persistence after reload, actual playback, identity across GPS refreshes, relocking, deletion and uncaught errors. The explicit shared variant additionally checks a second anonymous session, real Storage playback, cross-owner row/object write protection and creator cleanup. These tests do not establish physical iOS Safari/Android camera/microphone behaviour. Use real phones before recording the showreel.

Verified this increment: **23 Node, 21 existing regression, 12 local media and 9 real shared-media browser checks passed.** A database/storage read-back confirmed zero synthetic recording rows and zero recording objects after cleanup. Anonymous test Auth accounts remain; these are not participants.
