import type { Metadata } from "next";
import { Fraunces, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import { optionalUser } from "../lib/auth";
import { passwordAuthEnabled } from "../lib/password-auth";

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

/** `owner: true` items are hidden from anonymous visitors. */
const NAV = [
  { href: "/", label: "Dashboard", owner: false },
  { href: "/jobs", label: "Board", owner: false },
  { href: "/sources", label: "Sources", owner: false },
  { href: "/criteria", label: "Criteria", owner: true },
  { href: "/runs", label: "Runs", owner: false },
];

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const owner = await optionalUser();
  const loginHref = passwordAuthEnabled() ? "/login" : "/auth/login";

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
              {NAV.filter((item) => !item.owner || owner).map((item) => (
                <a key={item.href} href={item.href}>
                  {item.label}
                </a>
              ))}
            </nav>
          </header>
          <main>{children}</main>
          <footer className="footer">
            <span>JobScout — open board, personal pipeline</span>
            <span>
              {owner ? (
                "signed in · notifications via Discord"
              ) : (
                <a href={loginHref}>Owner sign in</a>
              )}
            </span>
          </footer>
        </div>
      </body>
    </html>
  );
}
