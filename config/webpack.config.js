'use strict';

const { merge } = require('webpack-merge');

const common = require('./webpack.common.js');
const PATHS = require('./paths');

// Merge the common config with entry points for this extension.
// Three entry points: side panel UI, Blackboard content script, service worker.
const config = (env, argv) =>
  merge(common, {
    entry: {
      sidePanel: PATHS.src + '/sidePanel.ts',
      contentScript: PATHS.src + '/contentScript.ts',
      background: PATHS.src + '/background.ts',
    },
    // Source maps in development only — not needed in production builds
    devtool: argv.mode === 'production' ? false : 'source-map',
  });

module.exports = config;
