# MasterScope site: how to edit

The pages in this repo are **built output**. Don't edit them directly: the next build overwrites them.

1. Edit the sources in `_src/` (page bodies like `_src/liminal.html`, `_src/press.html`, the analyser in `_src/body.html`, `_src/app.js`, `_src/dsp.js`, styles in `_src/style.css`; titles, descriptions and JSON-LD in `_src/build_site.py`).
2. Build: `python3 _src/build_site.py` (writes into the repo root; needs esbuild: `npm i -g esbuild` if it's missing).
3. Check `git status`: only the files you meant to change should differ.
4. Commit `_src/` and the built files together, push to main.

Images go in `img/` (kept by the build). Downloads in `downloads/`. New installers: `_src/launch_liminal.sh`.
A check on every push rebuilds from `_src/` and fails if the built pages don't match.
