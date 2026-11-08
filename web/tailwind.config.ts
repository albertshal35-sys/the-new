import type { Config } from "tailwindcss";
export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ice: { 50: "#f0f7fb", 100: "#dcecf5", 500: "#2b7aa8", 600: "#1f6290", 700: "#184d72", 900: "#0d2a40" },
      },
    },
  },
  plugins: [],
} satisfies Config;
