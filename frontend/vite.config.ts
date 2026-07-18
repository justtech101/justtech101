import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Low-RAM dev note: keep the dev server single-threaded on the Surface Pro
// by not enabling extra plugins beyond React fast-refresh.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
});
