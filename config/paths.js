"use strict";

const path = require("path");

// Resolve src and build directories relative to this config folder
const PATHS = {
  src: path.resolve(__dirname, "../src"),
  build: path.resolve(__dirname, "../build"),
};

module.exports = PATHS;
