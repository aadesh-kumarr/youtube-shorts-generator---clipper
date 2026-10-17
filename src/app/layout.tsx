import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Clipper.AI — YouTube Shorts Generator',
  description: 'Turn long-form YouTube videos into AI-selected, captioned vertical shorts.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <main>{children}</main>
      </body>
    </html>
  );
}
