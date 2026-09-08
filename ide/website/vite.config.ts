import { fileURLToPath, URL } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * Search Console HTML-tag verification has to live in the static HTML shell.
 * Google's ownership crawler does not execute our module graph, so putting the
 * token in page-meta.ts would silently fail verification.
 *
 * Token source: `GOOGLE_SITE_VERIFICATION` in `.env` / `.env.[mode]` or the
 * process environment. Vite does **not** copy unprefixed `.env` keys onto
 * `process.env` while evaluating this file — `loadEnv(mode, root, "")` is
 * required (empty prefix; the default would drop everything except `VITE_*`).
 * An empty value ships no meta; fabricating a token is worse than omitting it.
 */
function googleSiteVerificationToken(mode: string): string {
  const root = fileURLToPath(new URL(".", import.meta.url));
  // Empty prefix: Vite's default drops every key that is not `VITE_*`.
  const fromFile = loadEnv(mode, root, "").GOOGLE_SITE_VERIFICATION ?? "";
  // Shell-exported token as fallback. `process` is not in this tsconfig's
  // type roots (client stub), so we read it through globalThis.
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  const t = (fromFile || proc?.env?.GOOGLE_SITE_VERIFICATION || "").trim();
  if (!t) return "";
  if (!/^[A-Za-z0-9_-]{8,}$/.test(t)) {
    throw new Error(
      "GOOGLE_SITE_VERIFICATION must be the token from Search Console (letters, digits, _-). Do not paste a URL or invent one.",
    );
  }
  return t;
}

export default defineConfig(({ mode }) => {
  const verification = googleSiteVerificationToken(mode);
  return {
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "google-site-verification",
        transformIndexHtml(html: string) {
          if (!verification) return html;
          if (/name=["']google-site-verification["']/.test(html)) return html;
          return html.replace(
            "</head>",
            `    <meta name="google-site-verification" content="${verification}" />\n  </head>`,
          );
        },
      },
    ],
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
    server: {
      port: 5273,
      strictPort: true,
    },
  };
});
