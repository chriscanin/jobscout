import type { Metadata } from "next";
import { Fraunces, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import { getViewer } from "../lib/viewer";
import { signOutAction } from "../lib/actions";

const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-fraunces",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-plex",
});

export const metadata: Metadata = {
  title: "JobScout",
  description:
    "Personal job reconnaissance: curated sources, scored postings, one board.",
};

const NAV = [
  { href: "/", label: "Dashboard" },
  { href: "/jobs", label: "Board" },
  { href: "/sources", label: "Sources" },
  { href: "/criteria", label: "Criteria" },
  { href: "/runs", label: "Runs" },
];

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const viewer = await getViewer();
  const nav = viewer?.is_owner ? [...NAV, { href: "/people", label: "People" }] : NAV;
  return (
    <html lang="en" className={`${fraunces.variable} ${plexMono.variable}`}>
      <body>
        <div className="shell">
          <header>
            <div className="masthead">
              <span className="wordmark">
                <a href="/">
                  Job<span className="mark-scout">Scout</span>
                </a>
              </span>
              <span className="masthead-note">
                field reports · scored postings · no auto-apply
              </span>
            </div>
            <hr className="masthead-rule" />
            <hr />
            <nav className="nav">
              {nav.map((item) => (
                <a key={item.href} href={item.href}>
                  {item.label}
                </a>
              ))}
              {viewer && (
                <form action={signOutAction} className="nav-viewer">
                  <span>{viewer.name}</span>
                  <button type="submit" className="btn btn-quiet">
                    Sign out
                  </button>
                </form>
              )}
            </nav>
          </header>
          <main>{children}</main>
          <footer className="footer">
            <span>JobScout · shared with friends</span>
            <span>notifications via Discord</span>
          </footer>
        </div>
      </body>
    </html>
  );
}
