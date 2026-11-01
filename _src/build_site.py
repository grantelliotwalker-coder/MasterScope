#!/usr/bin/env python3
"""Builds the MasterScope site into ../site_out as separate pages.

Sources (edit these): body.html (landing + analyser), learn.html, liminal.html,
advertise.html, privacy.html, about.html, terms.html, liminal-guide.html, changelog.html, press.html, style.css, dsp.js, app.js, site.js, config.js.
Output: index.html, learn/, learn/<chapter>/, liminal/, advertise/, privacy/,
404.html, sitemap.xml, robots.txt, assets/ (minified CSS and JS + config.js).
"""
import html, os, re, shutil, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
# default output is the repo root this _src folder sits in
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(HERE)
ESBUILD = os.environ.get('ESBUILD') or shutil.which('esbuild') or next((p for p in ['/opt/npm-tools/node_modules/@esbuild/linux-x64/bin/esbuild'] if os.path.exists(p)), None)
if not ESBUILD:
    sys.exit('esbuild not found: npm i -g esbuild (or set ESBUILD=/path/to/esbuild)')
DOMAIN = 'https://masterscope.gwstudio.com.au'
YEAR = '2026'
BANNER = f'/*! MasterScope · © {YEAR} MasterScope (gwstudio.com.au). All rights reserved. Not licensed for reuse or redistribution. */'

EMAIL = re.search(r"contactEmail:\s*'([^']*)'", open(os.path.join(HERE, 'config.js'), encoding='utf-8').read()).group(1)
CONTACT = f'Email <a href="mailto:{EMAIL}">{EMAIL}</a>.' if EMAIL else 'Contact details are coming soon.'


# Liminal release: release.json (written by launch_liminal.sh) plus the installer in
# downloads/ switches every <!--live--> block on and every <!--soon--> block off.
_rel_path = os.path.join(HERE, 'release.json')
RELEASE = None
if os.path.exists(_rel_path):
    import json as _json
    _r = _json.load(open(_rel_path, encoding='utf-8'))
    # three installers (Full Suite, Liminal, Meter); an older release.json has one for everything
    _files = _r.get('files') or {k: {'setup': _r['setup'], 'sha256': _r['sha256'], 'bytes': _r['bytes']} for k in ('suite', 'liminal', 'meter')}
    if all(os.path.exists(os.path.join(OUT, 'downloads', f['setup'])) for f in _files.values()):
        RELEASE = dict(_r, files=_files)
LIVE = RELEASE is not None


def _release_blocks(t):
    keep, drop = ('live', 'soon') if LIVE else ('soon', 'live')
    t = re.sub(rf'<!--{drop}-->.*?<!--/{drop}-->\n?', '', t, flags=re.S)
    t = t.replace(f'<!--{keep}-->\n', '').replace(f'<!--/{keep}-->\n', '').replace(f'<!--{keep}-->', '').replace(f'<!--/{keep}-->', '')
    if LIVE:
        for prefix, key in (('SUITE', 'suite'), ('LIMINAL', 'liminal'), ('METER', 'meter')):
            f = RELEASE['files'][key]
            for k, v in {'VERSION': RELEASE['version'], 'URL': '/downloads/' + f['setup'], 'SHA': f['sha256'],
                         'SIZE': f"{f['bytes'] / 1048576:.1f} MB", 'DATE': RELEASE['date']}.items():
                t = t.replace('{{' + prefix + '_' + k + '}}', v)
    return t


def src(f):
    t = open(os.path.join(HERE, f), encoding='utf-8').read()
    if f.endswith('.html'):
        t = t.replace('{{EMAIL}}', EMAIL).replace('>Contact details are coming soon.<', f'>{CONTACT}<')
        t = _release_blocks(t)
    return t


def write(rel, text):
    p = os.path.join(OUT, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, 'w', encoding='utf-8').write(text)


def minify(text, loader, rel):
    tmp = os.path.join(OUT, rel + '.src')
    os.makedirs(os.path.dirname(tmp), exist_ok=True)
    open(tmp, 'w', encoding='utf-8').write(text)
    subprocess.run([ESBUILD, tmp, '--minify', f'--loader:.src={loader}', f'--banner:{"css" if loader == "css" else "js"}={BANNER}',
                    '--legal-comments=none', '--log-level=warning', f'--outfile={os.path.join(OUT, rel)}'], check=True)
    os.remove(tmp)


# ---------------------------------------------------------------- shared parts
FAVICON = '''<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon-96.png" type="image/png" sizes="96x96">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">'''
ORG = {'@type': 'Organization', '@id': DOMAIN + '/#org', 'name': 'MasterScope', 'url': DOMAIN + '/', 'logo': DOMAIN + '/icon-512.png',
       'parentOrganization': {'@type': 'Organization', 'name': 'GW Studio'}}


def jsonld(*items):
    import json
    data = {'@context': 'https://schema.org', '@graph': list(items)}
    return '<script type="application/ld+json">' + json.dumps(data, ensure_ascii=False, separators=(',', ':')).replace('</', '<\\/') + '</script>'


def crumbs(*pairs):
    return {'@type': 'BreadcrumbList', 'itemListElement': [{'@type': 'ListItem', 'position': i + 1, 'name': n, 'item': DOMAIN + u} for i, (n, u) in enumerate(pairs)]}

FONTS = '''<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">'''


def head(title, desc, path, ld=''):
    url = DOMAIN + path
    slug = path.strip('/').replace('/', '-')
    og = f'{DOMAIN}/og/{slug}.jpg' if slug and os.path.exists(os.path.join(HERE, 'og', slug + '.jpg')) else f'{DOMAIN}/img/og-card.png'
    return f'''<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' https://static.cloudflareinsights.com https://plausible.io; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self' https://cloudflareinsights.com https://plausible.io; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self' mailto:; upgrade-insecure-requests">
<meta name="referrer" content="strict-origin-when-cross-origin">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{html.escape(title)}</title>
<meta name="description" content="{html.escape(desc)}">
<meta name="copyright" content="© {YEAR} MasterScope. All rights reserved.">
<meta name="theme-color" content="#07080f">
<meta name="google-site-verification" content="ki7vluGRbvZJBGD0169rjvu5cZpHx4faEcWooFUYq0U">
<link rel="canonical" href="{url}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="MasterScope">
<meta property="og:title" content="{html.escape(title)}">
<meta property="og:description" content="{html.escape(desc)}">
<meta property="og:url" content="{url}">
<meta property="og:image" content="{og}">
<meta name="twitter:image" content="{og}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
{FAVICON}
{FONTS}
<link rel="stylesheet" href="/assets/site.css">
{ld}
</head>'''


BRAND = '''<svg width="26" height="26" viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" rx="14" fill="#6f86ff"/><circle cx="32" cy="32" r="24" fill="#3d5afe"/><circle cx="32" cy="32" r="24" fill="none" stroke="#fff" stroke-width="3"/><path d="M32 2v10M32 52v10M2 32h10M52 32h10" stroke="#fff" stroke-width="3" stroke-linecap="round"/><path d="M13 34 L19 34 L23 23 L28 43 L33 17 L38 47 L42 27 L45 34 L51 34" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
    <div>Master<span>Scope</span></div>'''


def topbar(active):
    a = lambda r, href, label: f'<a href="{href}" data-route="{r}"{" class=\"active\" aria-current=\"page\"" if r == active else ""}>{label}</a>'
    return f'''<header class="topbar">
  <a class="brand" href="/" style="text-decoration:none;color:inherit">
    {BRAND}
  </a>
  <nav class="site-nav" aria-label="Site">
    {a("analyse", "/", "Analyse")}
    {a("learn", "/learn/", "Learn")}
    {a("liminal", "/liminal/", "Liminal")}
    {a("meter", "/meter/", "Meter")}
    {a("soon", "/coming-soon/", "<span class=\"nav-long\">Coming soon</span><span class=\"nav-short\">Soon</span>")}
  </nav>
  <div class="spacer"></div>
  <button class="btn icon ghost" id="themeToggle" aria-label="Switch colour theme" title="Switch colour theme">
    <svg id="themeIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></svg>
  </button>
</header>'''


FOOTER = f'''<footer><span>© {YEAR} MasterScope. All rights reserved.</span><span>Runs entirely in your browser · Loudness per ITU-R BS.1770-4 and EBU R128</span><span class="foot-links"><a href="/learn/">Learn</a><a href="/liminal/">Liminal</a><a href="/meter/">Meter</a><a href="/about/">About</a><a href="/changelog/">What’s new</a><a href="/coming-soon/">Coming soon</a><a href="/advertise/">Advertise</a><a href="/press/">Press</a><a href="/privacy/">Privacy</a><a href="/terms/">Terms</a>{f'<a href="mailto:{EMAIL}">Contact</a>' if EMAIL else ''}</span></footer>'''


def static_page(path, title, desc, active, main, body_attrs='', ld=''):
    return f'''{head(title, desc, path, ld)}
<body{body_attrs}>
{topbar(active)}
<main>
{main}
</main>
{FOOTER}
<script src="/assets/config.js"></script>
<script src="/assets/site.js" defer></script>
<script src="/assets/bg3d.js" defer></script>
</body>
</html>
'''


def unhide(section_html):
    return section_html.replace('class="hidden page"', 'class="page"', 1)


def text_of(h):
    return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', '', h))).strip()


# ---------------------------------------------------------------- build
if os.path.isdir(OUT):
    for name in os.listdir(OUT):
        # keep anything the site build doesn't make: git, hosting, workflows, IndexNow key files
        if name in ('.git', '.github', '_src', '_config.yml', 'CLAUDE.md', 'CNAME', 'img', 'downloads', 'LICENSE', 'README.md') or re.fullmatch(r'[0-9a-f]{32}\.txt', name):
            continue
        p = os.path.join(OUT, name)
        shutil.rmtree(p) if os.path.isdir(p) else os.remove(p)
os.makedirs(OUT, exist_ok=True)

# assets
minify(src('style.css'), 'css', 'assets/site.css')
minify(src('dsp.js') + '\n' + src('app.js'), 'js', 'assets/app.js')
minify(src('site.js'), 'js', 'assets/site.js')
minify(src('bg3d.js'), 'js', 'assets/bg3d.js')
write('assets/config.js', src('config.js'))
shutil.copytree(os.path.join(HERE, 'og'), os.path.join(OUT, 'og'), dirs_exist_ok=True)
for f in os.listdir(os.path.join(HERE, 'static')):
    shutil.copy(os.path.join(HERE, 'static', f), os.path.join(OUT, f))

pages = []   # (path, priority)

# landing + analyser
body = src('body.html').replace('<!--PAGES-->\n', '').replace('<!--PAGES-->', '')
body = re.sub(r'<footer>.*?</footer>', FOOTER, body, flags=re.S)
index = f'''{head("MasterScope – Is your track ready to release?", "Drop your track and know if it's ready for Spotify, Apple Music, YouTube, SoundCloud and the club. Free, no account, and your audio never leaves your computer. Plus Liminal, a free mastering limiter.", "/", jsonld(
    ORG, {'@type': 'WebSite', '@id': DOMAIN + '/#site', 'name': 'MasterScope', 'url': DOMAIN + '/', 'publisher': {'@id': DOMAIN + '/#org'}},
    {'@type': 'WebApplication', 'name': 'MasterScope', 'url': DOMAIN + '/', 'applicationCategory': 'MultimediaApplication', 'operatingSystem': 'Any (runs in a web browser)',
     'description': 'Checks if a track is ready to release: loudness, true peak, peaks after streaming encoders, density, tone and stereo, with platform-by-platform verdicts and what to fix.',
     'offers': {'@type': 'Offer', 'price': '0', 'priceCurrency': 'AUD'}, 'publisher': {'@id': DOMAIN + '/#org'}}))}
<body class="landing-page">
{body}
<script src="/assets/config.js"></script>
<script src="/assets/app.js"></script>
<script src="/assets/bg3d.js" defer></script>
</body>
</html>
'''
write('index.html', index)
pages.append(('/', '1.0'))

# Learn: contents page plus one page per chapter
learn = src('learn.html')
toc_items = re.findall(r'<li><a href="/learn/([a-z-]+)/">(.*?)</a></li>', learn)
header = re.search(r'<header class="doc-head">.*?</header>', learn, re.S).group(0)
chapters = {cid: body for cid, body in re.findall(r'<section class="chapter" id="ch-([a-z-]+)">(.*?)</section>', learn, re.S)}
assert len(chapters) == len(toc_items) == 16, (len(chapters), len(toc_items))
# Search titles and descriptions for chapters that answer a common question
SEO = {'reference-loudness': ('How loud are the songs you\'re up against? Measure Spotify and YouTube tracks',
                              'Measure the loudness, true peak and density (PLR) of any song on Spotify or YouTube, and use it as your mastering target. Free, with MasterScope Meter.'),
       'sounds-worse-on-spotify': ('Why does my master sound worse on Spotify? Causes and fixes',
                              'Quieter, duller or crunchier on Spotify than in your DAW? Normalisation, lossy encoding and playback settings explained, with a checklist to fix it.'),
       'how-loud-to-master': ('How loud should you master? LUFS for Spotify, Apple Music and YouTube (2026)',
                              'How many LUFS to master to for Spotify, Apple Music, YouTube, SoundCloud and the club, why −14 isn\'t a target, and why your song sounds quieter than others on Spotify.')}
CTA = '''<div class="doc-cta">
            <div><b>Put it into practice</b><span>Open a mix in MasterScope, or get Liminal for your DAW.</span></div>
            <div class="cta-btns"><a class="btn primary" href="/">Analyse a track</a><a class="btn" href="/liminal/">Get Liminal</a></div>
          </div>'''


def toc(active):
    items = ''.join(f'<li><a href="/learn/{c}/"{" class=\"active\" aria-current=\"page\"" if c == active else ""}>{t}</a></li>' for c, t in toc_items)
    return f'''<aside class="doc-toc" aria-label="Chapters">
        <div class="toc-title"><a href="/learn/" style="color:inherit;text-decoration:none">Learn</a></div>
        <ol id="learnToc">{items}</ol>
      </aside>'''


cards = []
for i, (cid, title) in enumerate(toc_items):
    body_html = chapters[cid]
    first_p = re.search(r'<p>(.*?)</p>', body_html, re.S)
    desc = text_of(first_p.group(1)) if first_p else title
    desc = desc if len(desc) <= 158 else desc[:155].rsplit(' ', 1)[0] + '…'
    h2 = re.search(r'<h2>(.*?)</h2>', body_html).group(1)
    page_title, desc = SEO.get(cid, (f'{text_of(h2)} – MasterScope Learn', desc))
    content = body_html.replace(f'<h2>{h2}</h2>', f'<h1 class="ch-title">{h2}</h1>', 1)
    content = content.replace('<h3>', '<h2 class="sub">').replace('</h3>', '</h2>')
    if 'doc-cta' not in content:
        content += '\n          ' + CTA
    prev = toc_items[i - 1] if i > 0 else None
    nxt = toc_items[i + 1] if i + 1 < len(toc_items) else None
    pager = '<nav class="doc-pager" aria-label="Chapters">' + \
        (f'<a class="prev" href="/learn/{prev[0]}/"><small>Previous</small>{prev[1]}</a>' if prev else '<span></span>') + \
        (f'<a class="next" href="/learn/{nxt[0]}/"><small>Next</small>{nxt[1]}</a>' if nxt else '<span></span>') + '</nav>'
    main = f'''  <section class="page">
    <div class="doc">
      {toc(cid)}
      <article class="doc-body">
        <section class="chapter" id="ch-{cid}">{content}</section>
        {pager}
      </article>
    </div>
  </section>'''
    img = re.search(r'<img src="(/img/[^"]+)"', body_html)
    art = {'@type': 'Article', 'headline': text_of(h2), 'description': desc, 'url': DOMAIN + f'/learn/{cid}/', 'inLanguage': 'en',
           'image': DOMAIN + (img.group(1) if img else '/img/og-card.png'), 'author': ORG, 'publisher': ORG,
           'isPartOf': {'@type': 'Course', 'name': 'MasterScope Learn', 'description': 'A plain-English guide to mixing and mastering for streaming.', 'provider': ORG, 'url': DOMAIN + '/learn/'}}
    write(f'learn/{cid}/index.html', static_page(f'/learn/{cid}/', page_title, desc, 'learn', main,
                                                f' class="wide-page" data-chapter="{cid}"',
                                                jsonld(art, crumbs(('Learn', '/learn/'), (text_of(h2), f'/learn/{cid}/')))))
    pages.append((f'/learn/{cid}/', '0.8'))
    cards.append(f'<li><a href="/learn/{cid}/"><span class="n">{i + 1:02d}</span><b>{h2}</b><span>{html.escape(desc)}</span></a></li>')

learn_index = f'''  <section class="page">
    <div class="doc">
      {toc(None)}
      <article class="doc-body">
        {header}
        <ol class="learn-index">{''.join(cards)}</ol>
      </article>
    </div>
  </section>'''
write('learn/index.html', static_page('/learn/', 'Learn mixing and mastering for streaming – MasterScope',
                                      'A plain-English guide to loudness, peaks, density, tone, limiting and delivery: how to finish a track that holds its own next to commercial releases.',
                                      'learn', learn_index, ' class="wide-page"', jsonld(crumbs(('Learn', '/learn/')))))
pages.append(('/learn/', '0.9'))

# Liminal, Advertise, Privacy
write('liminal/index.html', static_page('/liminal/', 'Liminal – a free mastering limiter that lands on your target',
                                        'Press Learn, play your song once, and Liminal sets itself for your loudness or density, checks the peaks through real streaming encoders and hands MasterScope the report. Free VST3 and AU for Windows and Mac.',
                                        'liminal', unhide(src('liminal.html')), ' class="wide-page"', jsonld(
    {'@type': 'SoftwareApplication', 'name': 'Liminal', 'alternateName': 'Liminal by MasterScope', 'url': DOMAIN + '/liminal/',
     'applicationCategory': 'MultimediaApplication', 'applicationSubCategory': 'Audio plug-in (VST3), mastering limiter',
     'operatingSystem': 'Windows 10, Windows 11, macOS 10.13+', 'softwareVersion': '1.0.1', 'image': DOMAIN + '/img/liminal-learned.webp',
     'screenshot': DOMAIN + '/img/liminal-main.webp',
     'description': 'A free mastering limiter: press Learn, play your song once, and it sets itself for your loudness or density, checks the peaks through real Opus and Vorbis encoders, and hands MasterScope the report.',
     'offers': {'@type': 'Offer', 'price': '0', 'priceCurrency': 'AUD'}, 'publisher': ORG, 'license': DOMAIN + '/terms/#liminal',
     **({'downloadUrl': DOMAIN + '/downloads/' + RELEASE['setup'], 'fileSize': f"{RELEASE['bytes'] / 1048576:.1f} MB", 'datePublished': RELEASE['iso_date']} if LIVE else {})},
    crumbs(('Liminal', '/liminal/')))))
pages.append(('/liminal/', '0.9'))
write('liminal/guide/index.html', static_page('/liminal/guide/', 'Liminal user guide – install, Learn and every control',
                                              'How to install and use Liminal, the free mastering limiter: the quick start, Learn and targets, codec-safe ceilings, modes, every control, Optimise and the release pack.',
                                              'liminal', src('liminal-guide.html'), ' class="wide-page"', jsonld(
    {'@type': 'TechArticle', 'headline': 'How to use Liminal', 'url': DOMAIN + '/liminal/guide/', 'image': DOMAIN + '/img/liminal-main.webp',
     'about': {'@type': 'SoftwareApplication', 'name': 'Liminal', 'url': DOMAIN + '/liminal/'}, 'author': ORG, 'publisher': ORG, 'inLanguage': 'en'},
    crumbs(('Liminal', '/liminal/'), ('User guide', '/liminal/guide/')))))
pages.append(('/liminal/guide/', '0.7'))
write('meter/index.html', static_page('/meter/', 'MasterScope Meter – measure the loudness of any song on Spotify or YouTube',
                                      'A free Windows app that measures anything your computer plays: loudness, true peak, density (PLR), loudest moment and what each streaming service does to it. Compare it with your own track in MasterScope.',
                                      'meter', unhide(src('meter.html')), ' class="wide-page"', jsonld(
    {'@type': 'SoftwareApplication', 'name': 'MasterScope Meter', 'url': DOMAIN + '/meter/',
     'applicationCategory': 'MultimediaApplication', 'applicationSubCategory': 'Loudness meter',
     'operatingSystem': 'Windows 10, Windows 11', 'softwareVersion': '1.0.1', 'image': DOMAIN + '/img/meter-main.webp',
     'description': 'Measures the loudness, true peak, PLR and loudness range of anything your computer plays, and shows what Spotify, YouTube, Apple Music, Tidal, Amazon and Deezer do to it.',
     'offers': {'@type': 'Offer', 'price': '0', 'priceCurrency': 'AUD'}, 'publisher': ORG,
     **({'downloadUrl': DOMAIN + '/downloads/' + RELEASE['setup'], 'fileSize': f"{RELEASE['bytes'] / 1048576:.1f} MB", 'datePublished': RELEASE['iso_date']} if LIVE else {})},
    crumbs(('Meter', '/meter/')))))
pages.append(('/meter/', '0.8'))
write('about/index.html', static_page('/about/', 'About MasterScope', 'Why MasterScope and Liminal are free, who makes them, and how they are paid for.', '', src('about.html'), '', jsonld({'@type': 'AboutPage', 'url': DOMAIN + '/about/', 'about': ORG})))
pages.append(('/about/', '0.4'))
write('changelog/index.html', static_page('/changelog/', "What’s new – MasterScope and Liminal", 'Every update to the MasterScope analyser, the Learn guide and the free Liminal limiter, newest first.', '', src('changelog.html')))
pages.append(('/changelog/', '0.4'))
write('coming-soon/index.html', static_page('/coming-soon/', 'Coming soon – new free plug-ins from MasterScope', 'New free plug-ins in development from the makers of MasterScope, Liminal and Meter. See what is coming and check back for news.', 'soon', src('coming-soon.html')))
pages.append(('/coming-soon/', '0.5'))
write('press/index.html', static_page('/press/', 'Press kit – Liminal and MasterScope', 'Descriptions, facts, screenshots and logos for writing about the free Liminal limiter and MasterScope.', '', src('press.html')))
pages.append(('/press/', '0.3'))
write('terms/index.html', static_page('/terms/', 'Terms of use and Liminal licence – MasterScope', 'The terms for using MasterScope and the free licence for the Liminal plug-in.', '', src('terms.html')))
pages.append(('/terms/', '0.2'))
write('advertise/index.html', static_page('/advertise/', 'Advertise with MasterScope', 'Reach producers at the moment they finish and release music.', '', unhide(src('advertise.html'))))
pages.append(('/advertise/', '0.3'))
write('privacy/index.html', static_page('/privacy/', 'Privacy – MasterScope', 'Your audio never leaves your computer. What MasterScope stores and what it doesn\'t.', '', unhide(src('privacy.html'))))
pages.append(('/privacy/', '0.3'))

# 404, sitemap, robots
write('404.html', static_page('/404.html', 'Page not found – MasterScope', 'That page doesn\'t exist.', '',
                              '''  <section class="page"><div class="doc-page"><div class="eyebrow">404</div><h1>That page doesn't exist.</h1>
  <p class="lede">It may have moved. Try the <a href="/">analyser</a>, the <a href="/learn/">Learn guide</a> or <a href="/liminal/">Liminal</a>.</p></div></section>'''))
write('sitemap.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      ''.join(f'  <url><loc>{DOMAIN}{p}</loc><priority>{pr}</priority></url>\n' for p, pr in pages) + '</urlset>\n')
write('robots.txt', f'User-agent: *\nAllow: /\nSitemap: {DOMAIN}/sitemap.xml\n')
print('built', len(pages), 'pages into', os.path.abspath(OUT), '· downloads:', ('LIVE ' + ', '.join(f['setup'] for f in RELEASE['files'].values())) if LIVE else 'coming soon')
