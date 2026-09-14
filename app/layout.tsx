import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, Plus_Jakarta_Sans } from "next/font/google";
import Nav from "@/components/Nav";
import "./globals.css";

/**
 * Self-hosted at build time rather than linked from fonts.googleapis.com,
 * which would hand every visitor's IP to Google — a poor look on a tool whose
 * whole argument is about incidental disclosure. next/font also computes a
 * size-adjusted fallback, so the swap does not reflow the page.
 */
const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-jakarta",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
  variable: "--font-plex-mono",
});

export const metadata: Metadata = {
  title: "Remnant — what your files still carry",
  description:
    "Read, strip, forge and privately share the metadata and embedded payload inside your files. Runs in your browser; nothing is uploaded.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${jakarta.variable} ${plexMono.variable}`}>
      <body>
        <div className="container">
          <Nav />
        </div>
        {children}
      </body>
    </html>
  );
}
