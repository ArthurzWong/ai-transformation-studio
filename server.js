#!/usr/bin/env node
/**
 * AI Transformation Studio — local server entry point
 *
 * Local mode: persistent SQLite in ./data, fire-and-forget pipeline with
 * live progress polling. This is the full-fidelity deployment documented
 * in README.md ("Quick start").
 *
 * Run:  node server.js   →  http://127.0.0.1:8788
 */
"use strict";

const http = require("node:http");
const path = require("node:path");
const { handle, boot, DATA_DIR } = require("./lib/app");

const PORT = process.env.PORT ? Number(process.env.PORT) : 8788;

boot();
http.createServer(handle).listen(PORT, () => {
  console.log(`AI Transformation Studio → http://127.0.0.1:${PORT}`);
  console.log(`Database: ${path.join(DATA_DIR, "studio.db")}`);
});
