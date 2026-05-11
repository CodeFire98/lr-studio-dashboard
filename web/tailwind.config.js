/** @type {import('tailwindcss').Config} */
//
// Scoped Tailwind config for the AI Co-pilot v2 migration.
//
// IMPORTANT — coexistence with hand-written CSS:
//   1. `content` is restricted to the new ai-elements/ directory ONLY,
//      so Tailwind class scanning never touches the existing 100KB+ of
//      hand-written CSS in src/styles/app.css.
//   2. `corePlugins.preflight: false` disables Tailwind's CSS reset.
//      The hand-written app.css already has its own opinionated reset
//      and base styles; Tailwind's preflight would visually regress
//      every existing page if enabled.
//   3. Tailwind directives (@tailwind base/components/utilities) live
//      in src/styles/elements.css — imported only after app.css so its
//      utilities can override per-component when needed.
//
// shadcn/ui design tokens live in src/styles/elements.css as CSS
// variables. The theme.extend block below wires the Tailwind color
// utilities (bg-background, text-foreground, etc.) to those variables
// using `hsl(var(--name))` so AI Elements components inherit the same
// palette without us hand-mapping every class.
//
export default {
  darkMode: ["class"],
  content: ["./src/components/ai-elements/**/*.{js,ts,jsx,tsx}"],
  corePlugins: {
    preflight: false,
  },
  theme: {
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};
