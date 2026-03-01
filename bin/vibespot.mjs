#!/usr/bin/env node

import("../dist/index.js").catch((err) => {
  if (err.code === "ERR_MODULE_NOT_FOUND") {
    console.error(
      "vibeSpot has not been built yet. Run `npm run build` first."
    );
    process.exit(1);
  }
  throw err;
});
