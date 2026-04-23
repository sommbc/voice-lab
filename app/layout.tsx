import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Voiceover",
  description: "Turn pasted long-form text into one MP3 with Mistral Voxtral TTS."
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
