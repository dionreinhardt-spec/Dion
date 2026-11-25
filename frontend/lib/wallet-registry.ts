import type { WalletLabel } from "./wallet-intelligence.ts";

// Public provider attributions checked through Solana Tracker on 2026-11-25.
// These are not signatures proving personal ownership. Never infer a label from a ticker.
const label = (wallet: string, name: string, handle: string, note?: string): WalletLabel => ({ wallet, name, handle, source: "https://www.solanatracker.io/wallet/" + wallet, labelCheckedAt: "2026-11-25", note });
export const WALLET_REGISTRY: readonly WalletLabel[] = [
  label("6DQAGJT7VZPVBsuG4kn3AvpyHCEi7B2RFFvMZdbqQqqP", "Cupsey", "@Cupseyy", "Anbietername: cupsey; Anbieter-Tags enthalten potential_bot. Keine unabhängige Bestätigung des Eigentümers."),
  label("suqh5sHtr8HyJ7q8scBimULPkPpA557prMG47xCHQfK", "Cupsey", "@Cupseyy"),
  label("2fg5QD1eD7rzNNCsvnhmXFm5hqNgwTTG8p7kQ6f3rx6f", "Cupsey", "@Cupseyy"),
  label("CyaE1VxvBrahnPWkqm5VsdCvyS2QmNht2UFrKJHga54o", "Cented", "@Cented7"),
  label("AVAZvHLR2PcWpDf8BXY4rVxNHYRBytycHkcB5z5QNXYm", "Ansem", "@blknoiz06"),
  label("DNfuF1L62WWyW3pNakVkyGGFzVVhj4Yr52jSmdTyeBHm", "Gake", "@Ga__ke"),
  label("DfMxre4cKmvogbLrPigxmibVTTQDuzjdXojWzjCXXhzj", "Euris", "@Euris_JT"),
  label("JDd3hy3gQn2V982mi1zqhNqUw1GfV2UL6g76STojCJPN", "West", "@ratwizardx"),
];
