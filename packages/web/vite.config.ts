import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The browser talks to one origin: /api/* is forwarded to the API with the
// prefix stripped (the API has no /api prefix of its own). No CORS needed.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "^/api/": {
        target: "http://localhost:3000",
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
