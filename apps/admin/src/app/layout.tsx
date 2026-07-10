import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "JobScout Admin",
  description: "Personal job search queue",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <nav>
          <a href="/jobs">Jobs</a>
          <a href="/criteria">Criteria</a>
          <a href="/runs">Runs</a>
        </nav>
        <main>{children}</main>
      </body>
    </html>
  );
}
