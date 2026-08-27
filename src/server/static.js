"use strict";

const path = require("path");
const express = require("express");

function mountStatic(app) {
  // Local dev tool under active iteration — never let the browser cache
  // stale HTML/JS behind a "just refresh" expectation.
  app.use(
    express.static(path.join(__dirname, "..", "public"), {
      etag: false,
      lastModified: false,
      setHeaders: (res) => res.set("Cache-Control", "no-store"),
    })
  );
}

module.exports = { mountStatic };
