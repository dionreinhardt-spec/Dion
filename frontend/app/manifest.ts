import type { MetadataRoute } from "next";
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Axiom Intelligence",
    short_name: "Axiom Intel",
    description:
      "Dein persönlicher Solana-Analyst. Paper Trading mit transparenten Daten und Risiken.",
    lang: "de",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#0b0e13",
    theme_color: "#0b0e13",
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
