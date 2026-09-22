/**
 * AI Transformation Studio — Vercel serverless entry point (catch-all /api/*)
 *
 * Vercel mode: transient SQLite in /tmp (per-instance, resets on cold start),
 * pipeline executed synchronously within the request (demo ~3s).
 * Static assets are served from /public by Vercel's zero-config routing.
 *
 * Limitation (documented in README): serverless file systems are read-only
 * except /tmp and per-instance — runs created here are ephemeral. For the
 * persistent deployment, run `node server.js` locally.
 */
"use strict";

const { handle } = require("../lib/app");

module.exports = async (req, res) => handle(req, res);
