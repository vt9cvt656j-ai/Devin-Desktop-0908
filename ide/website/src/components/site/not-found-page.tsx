/**
 * Soft 404. nginx still serves 200 + index.html for unknown paths; rendering
 * the homepage here would duplicate `/` (the classic SPA soft-404). Title +
 * noindex is what this shell can do without a real status code — the caller
 * (`App.tsx`) is responsible for writing those.
 */
export function NotFoundPage() {
  return (
    <main id="main" className="mx-auto max-w-6xl px-4 py-24 sm:px-6 md:py-32">
      <h1 className="font-display text-3xl font-semibold tracking-tight text-foreground md:text-4xl">
        Page not found
      </h1>
      <p className="mt-4 max-w-prose text-muted-foreground">
        This URL is not a page on Mr. Day One.
      </p>
      <a
        href="/"
        className="mt-8 inline-block text-sm font-medium text-foreground underline underline-offset-4 transition-colors hover:text-muted-foreground"
      >
        Back to home
      </a>
    </main>
  );
}
