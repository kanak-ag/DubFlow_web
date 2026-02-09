import { Inter } from 'next/font/google'
import './globals.css'

const inter = Inter({ subsets: ['latin'] })

export const metadata = {
  title: 'YouTube Video Dubber',
  description: 'Transform any YouTube video into multiple languages with AI-powered dubbing',
  keywords: 'youtube, dubbing, AI, translation, video, multilingual',
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className={inter.className}>{children}</body>
    </html>
  )
}