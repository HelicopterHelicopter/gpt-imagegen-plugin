'use strict';
// Shared launcher for tests that need a throwaway headless browser.
//
// CI runners cannot use Chrome's sandbox (no unprivileged user namespaces, and
// often running as root), so puppeteer.launch crashes there with "No usable
// sandbox!". go-rod added --no-sandbox automatically when running as root;
// puppeteer does not, which is why this only surfaced after the Go->Node port.
//
// These flags are scoped to throwaway TEST browsers only and gated on CI. The
// production launch path in src/session.js drives the user's real Chrome and
// must never disable its sandbox.
//
// This lives in one place deliberately: the same crash appeared twice, in two
// test files, because the flags had been pasted into only one of them.
const puppeteer = require('puppeteer-core');

function ciSandboxArgs() {
  return process.env.CI ? ['--no-sandbox', '--disable-dev-shm-usage'] : [];
}

async function launchTestBrowser(executablePath, extraArgs = []) {
  return puppeteer.launch({
    executablePath,
    headless: true,
    args: [...ciSandboxArgs(), ...extraArgs],
  });
}

module.exports = { ciSandboxArgs, launchTestBrowser };
