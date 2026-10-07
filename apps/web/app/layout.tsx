import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Bulkhead",
  description: "Parallel, isolated AI agent sessions with Cardano wallets (preprod).",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
