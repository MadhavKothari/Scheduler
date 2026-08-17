import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `base: "./"` makes the build use relative asset paths, so it works
// whether GitHub Pages serves this from the repo root or from
// https://<user>.github.io/<repo-name>/ — no need to hardcode the repo name.
export default defineConfig({
  plugins: [react()],
  base: "./",
});
