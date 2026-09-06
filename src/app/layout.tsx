import type { Metadata } from 'next';
import { Noto_Sans } from 'next/font/google';
import './globals.css';

/*
 * Groww's own font is GrowwSans, which is proprietary. Their production CSS
 * declares the fallback chain "GrowwSans, NotoSans, system-ui", so Noto Sans is
 * literally the typeface Groww themselves fall back to. next/font downloads it
 * at build time and self-hosts it, so there is no runtime CDN to fail and no
 * layout shift.
 */
const sans = Noto_Sans({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-sans',
});

export const metadata: Metadata = {
  title: 'iKnoww',
  description:
    'A watchlist that knows why you are watching, and tells you when a trigger fired for the wrong reason.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={sans.variable}>
      <body>{children}</body>
    </html>
  );
}
