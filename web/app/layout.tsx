import "./globals.css";
import Link from "next/link";
import type { ReactNode } from "react";

export const metadata = { title: "IceCap Development Intelligence", description: "Boston development filings monitor" };

const NAV = [
  ["/", "Live feed"],
  ["/leads", "Leads"],
  ["/leads?eligibility=needs_review", "Needs review"],
  ["/map", "Map"],
  ["/developers", "Developers"],
  ["/pipeline", "Pipeline"],
  ["/health", "Sources & alerts"],
];

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="bg-ice-900 text-white">
          <div className="mx-auto max-w-[1500px] px-4 flex items-center gap-6 h-12">
            <Link href="/" className="font-semibold tracking-tight whitespace-nowrap">
              IceCap <span className="text-ice-100 font-normal">Development Intelligence</span>
            </Link>
            <nav className="flex gap-1 overflow-x-auto text-sm">
              {NAV.map(([href, label]) => (
                <Link key={href} href={href} className="px-2.5 py-1 rounded hover:bg-white/10 whitespace-nowrap">
                  {label}
                </Link>
              ))}
            </nav>
            <span className="ml-auto text-xs text-ice-100 hidden lg:block">Boston, MA · public records only</span>
          </div>
        </header>
        <main className="mx-auto max-w-[1500px] px-4 py-5">{children}</main>
      </body>
    </html>
  );
}
