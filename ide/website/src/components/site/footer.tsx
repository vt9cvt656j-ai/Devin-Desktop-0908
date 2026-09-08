import { Separator } from "@/components/ui/separator";

/*
 * Every link here used to point at github.com/fendoushaonian/Devin-Desktop. That
 * repository is private, so all five returned 404 to visitors — a footer where nothing
 * works reads as an abandoned product. They are gone until the repo is public; what is
 * left is only destinations that actually resolve today.
 */
const columns = [
  {
    heading: "Product",
    links: [
      { label: "Docs", href: "/docs" },
      { label: "Changelog", href: "/changelog" },
      { label: "Rankings", href: "/rankings" },
      { label: "Overview", href: "#features" },
      { label: "How it works", href: "#architecture" },
      { label: "Extensibility", href: "#extensions" },
      { label: "Reviews", href: "#customers" },
    ],
  },
  {
    heading: "Get started",
    links: [
      { label: "Download", href: "#download" },
      { label: "Sign in", href: "https://code.mrday.one/gate" },
      { label: "Create an account", href: "https://code.mrday.one/gate" },
    ],
  },
];

export function Footer() {
  return (
    <footer className="border-t border-border bg-background py-14">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="flex flex-col justify-between gap-10 sm:flex-row">
          <div className="max-w-xs">
            <p className="flex items-center gap-2.5 font-display text-lg font-semibold">
              <img src="/logo.png" alt="" className="size-8" />
              Mr. Day One
            </p>
            <p className="mt-3 text-sm text-muted-foreground">
              A native desktop code editor for MacOS and Windows, with an agent that verifies its
              own work.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-10">
            {columns.map((column) => (
              <div key={column.heading}>
                <p className="type-eyebrow mb-4">{column.heading}</p>
                <ul className="space-y-2.5">
                  {column.links.map((link) => (
                    <li key={link.label}>
                      <a
                        href={link.href}
                        className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                        {...(link.href.startsWith("http")
                          ? { target: "_blank", rel: "noreferrer" }
                          : {})}
                      >
                        {link.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
        <Separator className="my-10" />
        {/* text-center：这一行独占底部整行，左对齐会把它甩到最左边，和上面居中的版式对不齐。 */}
        <p className="text-center text-sm text-muted-foreground">
          © {new Date().getFullYear()} Mr. Day One.
        </p>
      </div>
    </footer>
  );
}
