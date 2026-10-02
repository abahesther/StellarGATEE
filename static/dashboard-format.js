/* Re-export alias for the dashboard format module.
 *
 * The test suite includes this file as `static/dashboard-format.js`
 * (see `tests/dashboard_asset_tests.rs`). The canonical source lives in
 * `static/format.js`, which is served as `/dashboard/format.js`. This file
 * re-exports everything so both paths stay in sync automatically.
 */
export * from "./format.js";
