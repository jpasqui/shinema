# Contributing to Shinema

Use a feature branch and pull request for every change. Keep incomplete work in draft and obtain approval before merging, following [AGENTS.md](AGENTS.md). Setup and test commands are in [docs/development.md](docs/development.md) and [docs/ci-builds.md](docs/ci-builds.md).

## Verification

Explain the reported behavior and the result after your change. Include reproduction steps, the test environment, relevant commands or manual checks, and observed results. List anything you could not verify; a generic statement that tests passed is insufficient.

For UI changes, provide clearly labeled screenshots showing both the previous and updated behavior. Add a brief recording when a still image cannot demonstrate motion, timing, transitions or interaction details. Upload the evidence to the PR or link it there. Keep assets made solely for PR review out of repository commits. Use generated fixtures and omit private library metadata, media, configuration and credentials.

Match verification to the affected behavior. Backend-only work does not require unrelated UI screenshots or recordings. Host/browser checks do not establish TV or device validation; report that limitation explicitly.

This evidence rule is adapted from T3Code's pinned [contribution verification guidance](https://github.com/pingdotgg/t3code/blob/7ac952c630ef8a60d14ca8f6a0c7adce33db4bae/CONTRIBUTING.md#verification) and [PR template](https://github.com/pingdotgg/t3code/blob/7ac952c630ef8a60d14ca8f6a0c7adce33db4bae/.github/pull_request_template.md). Its [MIT notice](docs/t3code-verification-license.txt) is retained. These instructions do not configure automatic PR closure or require video in CI.
