# Application repository separation

Urban Echo was extracted from the `/app` directory of [joshpilcher/urban-echo-process-journal](https://github.com/joshpilcher/urban-echo-process-journal).

Source snapshot: [`fd3aacf307e0452104cd9d11b2b580f1ab7ef25e`](https://github.com/joshpilcher/urban-echo-process-journal/commit/fd3aacf307e0452104cd9d11b2b580f1ab7ef25e), the tested Task 3 iteration in draft PR #1. The source repository retains the original commits and assessment evidence.

The application files now live at this repository’s root. Test commands and the browser-test server URL were updated for that layout. Generated browser captures go into ignored `test-results/screenshots/`; assessment evidence stays with the process journal. The app’s journal link points to the journal repository rather than a relative path in this application. The GPS and storage behaviour is unchanged. An optional `ECHO_TEST_OFFLINE=1` mode blocks external requests in browser checks so relocation can be tested without a map-tile or font connection.

This move does not deploy the app or migrate any user’s browser-local memories. Deployment to a different origin will use a separate browser storage area.
