import type { Config } from "tailwindcss"

export default {
  content: ["./apps/dashboard/src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Outfit", "system-ui", "sans-serif"],
        mono: ["IBM Plex Mono", "monospace"],
      },
      colors: {
        surface: {
          "900": "var(--surface-900)",
          "800": "var(--surface-800)",
          "700": "var(--surface-700)",
          "600": "var(--surface-600)",
          "500": "var(--surface-500)",
        },
        accent: {
          violet: "#8b5cf6",
          violetDim: "#7c3aed",
          violetGlow: "rgba(139, 92, 246, 0.15)",
          cyan: "#06b6d4",
          teal: "#10b981",
          amber: "#f59e0b",
          red: "#ef4444",
        },
      },
    },
  },
  plugins: [],
} satisfies Config
