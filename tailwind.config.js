/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        felt: {
          DEFAULT: '#0f5132',
          dark: '#0a3d26',
          light: '#157347',
        },
        // Colorblind-friendly four-color suit palette.
        suit: {
          spade: '#1f2937',
          heart: '#dc2626',
          diamond: '#2563eb',
          club: '#16a34a',
        },
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      keyframes: {
        dealIn: {
          '0%': { transform: 'translateY(-40px) scale(0.6)', opacity: '0' },
          '100%': { transform: 'translateY(0) scale(1)', opacity: '1' },
        },
        chipMove: {
          '0%': { transform: 'translateY(0) scale(0.8)', opacity: '0' },
          '100%': { transform: 'translateY(0) scale(1)', opacity: '1' },
        },
        flipIn: {
          '0%': { transform: 'rotateY(90deg)', opacity: '0' },
          '100%': { transform: 'rotateY(0)', opacity: '1' },
        },
        pulseRing: {
          '0%, 100%': { boxShadow: '0 0 0 0 rgba(250, 204, 21, 0.7)' },
          '50%': { boxShadow: '0 0 0 6px rgba(250, 204, 21, 0)' },
        },
      },
      animation: {
        dealIn: 'dealIn 0.35s ease-out both',
        chipMove: 'chipMove 0.3s ease-out both',
        flipIn: 'flipIn 0.4s ease-out both',
        pulseRing: 'pulseRing 1.5s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
