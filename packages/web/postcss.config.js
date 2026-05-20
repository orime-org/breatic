// Tailwind 4 moved off PostCSS — @tailwindcss/vite plugin (see
// vite.config.mts) handles tailwindcss processing. PostCSS only runs
// autoprefixer for vendor prefixes.
module.exports = {
  plugins: {
    autoprefixer: {},
  },
};

