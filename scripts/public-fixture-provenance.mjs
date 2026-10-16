/** Public metrics are explicit; unrelated diagnostics stay local. */
export function publicFixtureMetrics(result) {
  return {
    methodology: result.methodology,
    checks: result.checks,
    feedAppends: result.feedAppends,
    layoutOracle: result.layoutOracle,
    seeks: result.seeks,
    browser: result.browser,
    hevcStartupMs: result.hevcStartupMs,
  };
}
