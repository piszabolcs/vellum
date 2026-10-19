/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // CSS-változó-alapú márkaszínek, hogy futásidőben (Dark Mode class)
        // cserélhetők legyenek. Az rgb(var / <alpha-value>) minta megőrzi az
        // opacity módosítók (pl. bg-vellum-bronze/20) működését.
        'vellum-ink': 'rgb(var(--vellum-ink-rgb) / <alpha-value>)',
        'vellum-bronze': 'rgb(var(--vellum-bronze-rgb) / <alpha-value>)',
        'vellum-bronze-light': 'rgb(var(--vellum-bronze-light-rgb) / <alpha-value>)',
        'vellum-teal': 'rgb(var(--vellum-teal-rgb) / <alpha-value>)',
        'text-primary': '#F1EDE6',
        'text-secondary': '#A8ADB8',
        success: '#4FD6B5',
        warning: '#E0A458',
        danger: '#E0637A'
      },
      fontFamily: {
        sans: ['"Segoe UI Variable"', '"Segoe UI"', 'system-ui', 'sans-serif'],
        display: ['"Constantia"', '"Cambria"', 'Georgia', 'serif'],
        mono: ['"Cascadia Code"', '"Consolas"', 'monospace']
      }
    }
  },
  plugins: []
};
