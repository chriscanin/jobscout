import type { Metadata } from "next";
import { Fraunces, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

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

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
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
              {NAV.map((item) => (
                <a key={item.href} href={item.href}>
                  {item.label}
                </a>
              ))}
            </nav>
          </header>
          <main>{children}</main>
          <footer className="footer">
            <span>JobScout — personal use</span>
            <span>notifications via Discord</span>
          </footer>
        </div>
      </body>
    </html>
  );
}
