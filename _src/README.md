# MasterScope site: how to edit

**More than one Claude session works on this repo.** Before you change anything:
1. `git pull` first, and again right before you push. If the push is rejected, pull, rebuild with `python3 _src/build_site.py`, and keep the other session's work.
2. Read **Decisions** at the bottom of this file. Don't reverse one unless Grant asks you to in your conversation; if he does, update the decision here in the same commit, so other sessions follow it too.
3. When Grant settles something new about content, design, releases or the plan, add it to **Decisions** (one line, with the date).

The pages in this repo are **built output**. Don't edit them directly: the next build overwrites them.

1. Edit the sources in `_src/` (page bodies like `_src/liminal.html`, `_src/press.html`, the analyser in `_src/body.html`, `_src/app.js`, `_src/dsp.js`, styles in `_src/style.css`; titles, descriptions and JSON-LD in `_src/build_site.py`).
2. Build: `python3 _src/build_site.py` (writes into the repo root; needs esbuild: `npm i -g esbuild@0.28.2` if it's missing; other versions minify slightly differently).
3. Check `git status`: only the files you meant to change should differ.
4. Commit `_src/` and the built files together, push to main.

Images go in `img/` (kept by the build). Downloads in `downloads/`. New installers: `_src/launch_liminal.sh`.
A check on every push rebuilds from `_src/` and fails if the built pages don't match.

## Changelog style (`_src/changelog.html`)
One entry per version (1.0.1, 1.1 …), newest first, with its date. List only what a producer would notice: new features and visible changes, one short line each. Small fixes go in a single "Fixes and improvements." line. No bug details, no testing or validation details, no website housekeeping (share images, contrast, contact address).

## Releasing new installers
Windows: `_src/launch_liminal.sh` (copies from the Liminal repo's `dist` branch and fills the download details from `release.json`). Mac: copy `Liminal-<version>-macOS.pkg` from the Liminal repo's `dist-mac` branch into `downloads/` (check its sha256 against `release.json` there), then update the Mac file name, version and SHA-256 in `_src/liminal.html` and `_src/liminal-guide.html`. Remove the previous version's installers from `downloads/`. On push, `.github/workflows/release.yml` publishes every installer for the new version to GitHub Release `v<version>` (it checks the Windows SHA-256s against `release.json`); the site's buttons link there, so keep `version` in `release.json` and the Mac file name in `_src/liminal.html` (`{{DL_BASE}}…`) in step.

## Decisions
Settled by Grant. Follow these; change one only when Grant asks, and record the change here.

- **Grant is named as the maker** (1 Nov 2026). About says "MasterScope is made by Grant Walker at GW Studio". The home page note under "Why is it free?" is his, signed "Grant Walker, producer, and the maker of MasterScope and Liminal", with his round photo linking to https://music.gwstudio.com.au/. Never present Grant (or anyone connected to GW Studio) as an independent user, and never write testimonials or reviews in anyone's voice; real third-party quotes only, with permission.
- **Favicon** (1 Nov 2026): full-bleed square, lighter outer blue `#6f86ff` with the darker scope inside, no transparency, so Google shows it without a white disc. Keep it opaque.
- **Liminal on Mac** (1 Nov 2026): universal VST3 and AU, macOS 10.13+. Unsigned for now (no Apple Developer account yet): keep the "Open Anyway" steps on the Liminal page and guide. "Listen to this computer" and MasterScope Meter stay Windows-only.
- **Formats**: VST3 (Windows and Mac) and AU (Mac). No VST2 (Steinberg no longer licenses it). AAX not planned yet.
- **Versions** (1 Nov 2026): 1.0 was the first public release; 1.0.1 is current (new installers, Meter asks for a song name). Installers on the site always come from the CI branches (`dist`, `dist-mac`), never hand-built.
- **Code signing**: not yet. Apple is US$99/year (yearly only); Windows signing to be decided. Don't promise signed builds on the site.
- **Languages** (1 Nov 2026): English only for now. Revisit in 2 to 3 months using Search Console's Countries report; Spanish first if the data supports it.
- **Search**: Google Search Console and Bing Webmaster Tools are set up with the sitemap. IndexNow submits changed pages after every push (`.github/workflows/indexnow.yml`); keep the key file `3689232d704a14b7fe577b516af0b4d2.txt` at the root.
- **Next up** (1 Nov 2026): KVR listing for Liminal (Mac, Windows, VST3, AU), a note to free-plugin blogs, then community posts. A real-Mac check in Logic or GarageBand is on hold until a Mac user is available.
- **Photos of Grant** (1 Nov 2026): keep the site about the tools, not about Grant. Only the small round headshot (cropped from his Hero photo, `img/grant-avatar.webp`) next to his note, and his studio-desk photo as a faint, blurred backdrop behind "Why is it free?" (`img/studio-desk-bg.webp`, both themes). No other personal photos.
- **3D background** (1 Nov 2026): a faint drifting 3D wave terrain behind every page (`_src/bg3d.js`, one fixed canvas). Keep it subtle; it stops for reduced motion and is hidden in print.
- **Changelog** (1 Nov 2026): history starts at 1.0, one entry for the first release of all three tools; later versions follow the changelog style above.
- **Coming soon page** (1 Nov 2026): `/coming-soon/` (`_src/coming-soon.html`), a nav tab ("Soon" on phones) and a footer link. Unnamed tools show as locked cards; when Grant names a tool, replace a locked card with a blurb (template in the file's comment). Never invent tool names or features.
- **Security policy** (1 Nov 2026): every page carries a Content-Security-Policy meta tag (in `head()` in `_src/build_site.py`). No inline `<script>` or `onclick=` attributes anywhere, including the PDF report windows (the opener wires them up). A new outside script, font or API host must be added to that policy or it will be blocked. Old installers are removed from `downloads/` on each release.
- **Tagline** (2 Nov 2026): "Free tools for release-ready masters." (`TAGLINE` in `_src/build_site.py`): footer, About title, Organization slogan, press kit, share images. Not under the header logo. Sitemap `<lastmod>` dates come from `_src/lastmod.json` (updated by the build when a page's HTML changes; commit it with the build).
- **Download counts** (2 Nov 2026): installers are served from the GitHub Release (`DL_BASE` in `_src/build_site.py`), so GitHub counts each download. Copies stay in `downloads/` (the workflow uploads from there, and old links keep working). To see the counts: Actions → Publish installers as a GitHub Release → Run workflow; the log ends with each file's downloads. Never delete and re-upload a release asset (it resets its count).
