# Shared Echo setup — pending live connection

The app works with device-only photos without this backend. Public is disabled while `config.js` has empty values. No database migration or real cloud upload has been performed for this iteration.

1. Choose a dedicated Supabase project for Urban Echo. Do not use a paid project or unrelated application's database by accident.
2. Apply `schema.sql` once as a migration. It creates the public Echo table, owner policies and a public JPEG photo bucket with a 1.5 MB object limit.
3. Enable Anonymous Sign-Ins in Supabase Auth. Reading does not create an account; contributing starts a persistent anonymous session in that browser.
4. Put the project URL and **publishable** key in `config.js`. A legacy anon key can also work. Never include a secret or service-role key. This configuration is intentionally public client code.
5. Serve over HTTPS and test with two independent browser sessions. A public photo Echo created in session A must appear after Refresh in session B. Its story and photo open within the proximity rule. Session B must have no Delete control for A's Echo.
6. Verify RLS with authenticated requests as two different users: B cannot insert with A's owner ID, delete A's row, upload into A's photo folder or remove A's photo. Unauthenticated writes must fail. Verify these against the real service; adapter unit tests are not proof of database enforcement.
7. Test upload failure, failed insert, retry, offline refresh and creator deletion. Remove synthetic test contributions afterwards. Record actual results in the journal before describing shared discovery as operational.

## Sharing model

Only this device is the default. Public explicitly shares the title, story, exact coordinates and optional re-encoded photo. Existing memories are never silently uploaded. Public data can be read through the API and public bucket URLs; the 100 m interaction is client-side discovery, not confidentiality.

The current anonymous session identifies the creator for deletion. There is no sign-in or recovery flow, so clearing browser data loses management of public contributions. The prototype reads the newest 200 public records; it has no moderation interface or scalable geographic query yet. Supabase remains a separate service from GitHub Pages, which serves the static app.

Photo upload and row creation are separate operations. A failed insert is reconciled before deleting an uploaded photo, so a lost success response does not remove a committed Echo's image. If reconciliation is also offline, a temporary orphan may remain for retry/cleanup. Deletion removes the photo before the row; a later row-deletion failure can leave an Echo without its image until the creator retries. These limits need live testing.

## Dependencies

The official Supabase JavaScript SDK 2.118.0 and its MIT licence are vendored in `vendor/supabase/`. No build system or server secret is needed on GitHub Pages.
