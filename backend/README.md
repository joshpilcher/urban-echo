# Shared Echo setup and verification

The app supports device-only photos and explicitly public contributions. The dedicated Sydney project `jamgivrngcderqmemjmb` has the table, public photo bucket and ownership policies. Anonymous sign-ins are enabled. The client uses the project URL and a public publishable key in `config.js`; no privileged key is included.

Verified on 19 October 2026 with seven live browser checks: real photo upload and row creation, another session reading the contribution and loading its image, client proximity locking/unlocking, failed-insert draft preservation, and creator deletion after reload. Actual API requests rejected forged owner IDs, unauthenticated inserts, cross-user updates/uploads and cross-user row/photo deletion. The test row and photo were removed; two anonymous test Auth accounts remain. The GPS and image were synthetic, not field evidence.

Before anonymous sign-ins were enabled, the security advisor returned no findings after least-privilege grants were applied. The subsequent advisor run reports [Anonymous Access Policies](https://supabase.com/docs/guides/database/database-advisors?queryGroups=lint&lint=0012_auth_allow_anonymous_sign_ins) for the deliberately accessible contributor policies on the Echo table and Storage; live tests confirm those writes/deletes remain owner-scoped. It also reports [leaked password protection disabled](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection) on the default email provider. The application exposes no email/password flow; that provider is still enabled in project defaults. The performance advisor noted two unused indexes on the initially empty table; these support date ordering and owner lookups. [Unused-index guidance](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index).

1. The dedicated Urban Echo project is in the student organisation, in `ap-southeast-2`. The existing BikePark project was not changed.
2. Applied migrations: `urban_echo_public_memories` and `urban_echo_least_privilege_grants`. `schema.sql` is the consolidated setup. The second migration revokes inherited broad grants before granting only public SELECT and authenticated INSERT/DELETE; RLS enforces ownership. The JPEG bucket limit is 1,572,864 bytes.
3. Anonymous Sign-Ins are enabled in Supabase Auth. Reading does not create an account; contributing starts a persistent anonymous session in that browser.
4. The project URL and **publishable** key are in `config.js`. A legacy anon key can also work. Never include a secret or service-role key. This configuration is intentionally public client code.
5. Serve over HTTPS and test with two independent browser sessions. A public photo Echo created in session A must appear after Refresh in session B. Its story and photo open within the proximity rule. Session B must have no Delete control for A's Echo.
6. Verify RLS with authenticated requests as two different users: B cannot insert with A's owner ID, delete A's row, upload into A's photo folder or remove A's photo. Unauthenticated writes must fail. Verify these against the real service; adapter unit tests are not proof of database enforcement.
7. Re-run `npm run test:shared` explicitly when live verification is needed. It creates synthetic contributions, exercises the real backend and deletes its Echo/photo afterwards. Normal regression tests stay device-only. Add real phone/browser outcomes to the journal as they are observed.

## Sharing model

Only this device is the default. Public explicitly shares the title, story, exact coordinates and optional re-encoded photo. Existing memories are never silently uploaded. Public data can be read through the API and public bucket URLs; the 100 m interaction is client-side discovery, not confidentiality.

The current anonymous session identifies the creator for deletion. There is no sign-in or recovery flow, so clearing browser data loses management of public contributions. Default anonymous sign-up rate limits remain in place; CAPTCHA and a moderation interface are not configured. The prototype reads the newest 200 public records; it has no moderation interface or scalable geographic query yet. Supabase remains a separate service from GitHub Pages, which serves the static app.

Photo upload and row creation are separate operations. A failed insert is reconciled before deleting an uploaded photo, so a lost success response does not remove a committed Echo's image. If reconciliation is also offline, a temporary orphan may remain for retry/cleanup. Deletion removes the photo before the row; a later row-deletion failure can leave an Echo without its image until the creator retries. These limits need live testing.

## Dependencies

The official Supabase JavaScript SDK 2.118.0 and its MIT licence are vendored in `vendor/supabase/`. No build system or server secret is needed on GitHub Pages.

## Audio/video extension — 21 October 2026

Applied additive migration `urban_echo_audio_video_memories`; `recordings.sql` contains the upgrade after `schema.sql`. It adds nullable `media_kind`/`media_path` columns and a constraint requiring audio/video, a creator-scoped path/known extension, and no simultaneous photo. Existing rows, the JPEG bucket and its limit are unchanged. Recordings have a separate public `urban-echo-recordings` bucket with a 20 MiB limit and an explicit MIME allowlist. INSERT/SELECT/DELETE policies scope object management to the current anonymous creator’s folder; no UPDATE/upsert permission is added. The existing table RLS and least-privilege grants cover the new columns.

The browser limits audio to 8 MiB / 60 seconds and video to 20 MiB / 30 seconds. The bucket enforces 20 MiB/type restrictions, but duration and the stricter audio size limit are client checks, not server media inspection. There is no transcoder, content moderation, automatic transcript or universal codec guarantee. Public files are intentionally downloadable by anyone knowing their URL. Imported media is not stripped of metadata. Existing upload/reconciliation/deletion caveats apply to recordings too.

A read-back query verified the new columns, CHECK constraint, bucket limits/types and all three owner policies. The security advisor reports the same categories as previously: deliberately anonymous contributor policies (now also covering recordings) and leaked-password protection disabled on the unused email/password provider. The remediation links above remain applicable. No new table without RLS was introduced. `npm run test:shared-media` explicitly runs real service verification; `npm run test:media` stays local.

Nine real shared-media browser checks passed for this extension: audio and video capture/upload, reload/playback/relocking, second-session playback with cross-owner row/object deletion and upload rejection, creator removal, and no uncaught application errors. A final database/storage count confirmed zero synthetic recording rows and zero recording objects. Synthetic devices/GPS were used, and anonymous test Auth accounts remain. No field results are implied.
