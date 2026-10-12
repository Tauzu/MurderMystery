import type { ReactNode } from 'react';
import './globals.css';

export const metadata = { title: 'マーダーミステリー・オンライン' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body>
        <main>{children}</main>
      </body>
    </html>
  );
}
