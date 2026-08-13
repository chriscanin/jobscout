/**
 * Display metadata for the curated discovery sources (migration 0004).
 * Keys mirror @jobscout/core's CuratedSourceKey; the crawler owns fetching —
 * this is presentation only (labels, homepages, cadence blurbs).
 */
import type { CuratedSourceKey } from "@jobscout/core";

export interface SourceMeta {
  label: string;
  href: string;
  cadence: string;
  description: string;
}

export const SOURCE_META: Record<CuratedSourceKey, SourceMeta> = {
  "yc-directory": {
    label: "YC startup directory",
    href: "https://www.ycombinator.com/companies",
    cadence: "daily",
    description:
      "Currently-hiring YC companies from the directory (via the yc-oss mirror), newest batches first.",
  },
  "ramp-vendor-report": {
    label: "Ramp vendor reports",
    href: "https://ramp.com/data",
    cadence: "monthly",
    description:
      "Ramp Economics Lab's monthly top-SaaS-vendors report — the fastest-growing tools by real corporate spend.",
  },
  "harmonic-hot25": {
    label: "Harmonic Hot 25",
    href: "https://harmonic.ai",
    cadence: "quarterly",
    description:
      "Harmonic's quarterly list of the 25 fastest-heating startups by headcount and funding signals.",
  },
  "a16z-build": {
    label: "a16z Build newsletter",
    href: "https://a16zbuild.substack.com",
    cadence: "weekly",
    description:
      "Weekly roundup of open roles at breakout a16z-orbit startups, companies named right in the titles.",
  },
  "founders-you-should-know": {
    label: "Founders You Should Know",
    href: "https://newsletter.foundersysk.com",
    cadence: "weekly",
    description:
      "Founder profiles of under-the-radar companies — names live in the essay bodies, extracted per issue.",
  },
  "next-play": {
    label: "Next Play newsletter",
    href: "https://nextplayso.substack.com",
    cadence: "weekly",
    description:
      '"Should you join X" deep-dives and fast-growing-startup roundups from the Next Play talent community.',
  },
  "early-days": {
    label: "Early Days",
    href: "https://earlydaysbymerlin.substack.com",
    cadence: "weekly",
    description:
      "Early-stage company crushes and a monthly jobs & talent board from two startup junkies.",
  },
  "vc-a16z": {
    label: "a16z portfolio",
    href: "https://a16z.com/portfolio/",
    cadence: "on change",
    description:
      "Every company in the a16z portfolio grid, parsed from the page's structured data.",
  },
  "vc-sequoia": {
    label: "Sequoia portfolio",
    href: "https://sequoiacap.com/our-companies/",
    cadence: "on change",
    description: "Sequoia's public company listing, extracted per page version.",
  },
  "vc-index": {
    label: "Index Ventures portfolio",
    href: "https://www.indexventures.com/companies/",
    cadence: "on change",
    description:
      "Index's company directory, read from the page's JSON-LD item list.",
  },
  "vc-founders-fund": {
    label: "Founders Fund portfolio",
    href: "https://foundersfund.com/portfolio/",
    cadence: "on change",
    description:
      "Founders Fund's portfolio, parsed from the page's embedded company JSON.",
  },
  "tc-funding": {
    label: "TechCrunch venture news",
    href: "https://techcrunch.com/category/venture/",
    cadence: "daily",
    description:
      "Funding announcements — freshly funded startups hire within weeks.",
  },
  "product-hunt": {
    label: "Product Hunt launches",
    href: "https://www.producthunt.com",
    cadence: "daily",
    description:
      "Daily launches: the earliest possible signal, a year before the startup lists.",
  },
  "pragmatic-engineer": {
    label: "Pragmatic Engineer",
    href: "https://newsletter.pragmaticengineer.com",
    cadence: "weekly",
    description:
      "Companies surfaced by the biggest engineering newsletter — correlates with good eng culture.",
  },
  "startup-lists": {
    label: "Annual startup lists",
    href: "https://www.forbes.com/lists/ai50/",
    cadence: "yearly",
    description:
      "Forbes AI 50, LinkedIn Top Startups, and Enterprise Tech 30, each list one tracked item.",
  },
};
