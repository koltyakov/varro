import { defineConfig } from "vite"
import solid from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { resolve } from "path"

export default defineConfig({
  plugins: [solid(), tailwindcss()],
  build: {
    lib: {
      entry: resolve(__dirname, "src/webview/index.tsx"),
      name: "opencodeWebview",
      formats: ["iife"],
      fileName: () => "webview.js",
    },
    outDir: resolve(__dirname, "dist/webview"),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        assetFileNames: "webview.[ext]",
      },
    },
    minify: "esbuild",
    sourcemap: true,
    target: "es2022",
  },
  define: {
    "process.env": {},
  },
})
