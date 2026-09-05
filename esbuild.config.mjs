// Bundles the CLI entry point (src/cli.js, via bin/gpt-imagegen.js) into a
// single self-contained CommonJS file at plugins/gpt-imagegen/dist/index.cjs.
// That file is committed to git, so a clone of this repo needs no
// `npm install` to run the plugin.
//
// outfile lives INSIDE plugins/gpt-imagegen/ on purpose. `/plugin install`
// copies only the plugin directory named by marketplace.json; a bundle
// emitted to the repo root is never shipped, and the installed plugin dies
// on `Cannot find module`. test/install.test.js proves the installed
// layout works without a checkout around it.
//
// platform: 'node', format: 'cjs': the file runs under plain `node`, no ESM
//   loader gymnastics.
// bundle: true, with nothing marked external: puppeteer-core (the only
//   runtime dependency) is inlined along with everything it requires, so
//   node_modules/ is not needed at run time. There is deliberately no
//   `external` list here -- that is the whole point of this bundle.
// minify: false: this artifact is committed and reviewed in diffs. An
//   unminified bundle is the only way a reviewer can tell what changed
//   between two commits of dist/index.cjs.
// target matches the engines.node floor in package.json (Node 20), so
// esbuild doesn't emit syntax newer than what this plugin promises to run
// on, and doesn't spend effort down-leveling for anything older.
//
// src/selectors.json is NOT listed as an asset to copy: src/selectors.js
// requires it with a static, literal path, which esbuild's JSON loader
// inlines as a JS object literal at bundle time (see the comment in
// selectors.js). There is nothing to verify beyond grepping the built
// bundle for the JSON's own content, which `make bundle` / CI does not do
// automatically, but is easy to spot-check by hand.

import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['bin/gpt-imagegen.js'],
  outfile: 'plugins/gpt-imagegen/dist/index.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  minify: false,
  sourcemap: false,
  logLevel: 'info',
});
