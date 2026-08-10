import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

const title = "5일 뒤 마왕 — 협동 로그라이트 디펜스";
const description =
  "낮에는 원정하고 밤에는 지켜라. 신참 용사 셋이 5일 안에 마왕을 쓰러뜨리는 웹 게임 프로토타입.";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const imageUrl = new URL("/og.png", `${protocol}://${host}`).toString();

  return {
    title,
    description,
    icons: { icon: "/og.png" },
    openGraph: {
      title,
      description,
      type: "website",
      locale: "ko_KR",
      images: [{ url: imageUrl, width: 1200, height: 630, alt: "5일 뒤 마왕 픽셀 판타지 원정대" }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [imageUrl],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
