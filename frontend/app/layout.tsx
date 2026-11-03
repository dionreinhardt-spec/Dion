import type { Metadata, Viewport } from "next";
import { PwaBootstrap } from "../components/pwa-bootstrap";
import "./globals.css";
export const metadata: Metadata = {
  title: "Axiom Intelligence · iPhone Terminal",
  applicationName: "Axiom Intelligence",
  description:
    "Independent, paper-only Solana intelligence terminal for iPhone. No affiliation with Axiom Trade.",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "Axiom Intel",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: [{ url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
    apple: [
      {
        url: "/icons/apple-touch-icon.png",
        sizes: "180x180",
        type: "image/png",
      },
    ],
  },
  formatDetection: { telephone: false },
};
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0b0e13",
  colorScheme: "dark",
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="de">
      <body>
        {children}
        <PwaBootstrap />
      </body>
    </html>
  );
}
