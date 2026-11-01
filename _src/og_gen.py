#!/usr/bin/env python3
"""Share images (1200x630) for every page: python3 og_gen.py  ->  og/<slug>.png"""
import html, json, os, re
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__))
src = lambda f: open(os.path.join(HERE, f), encoding='utf-8').read()
txt = lambda h: re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', '', h))).strip()

def short(t, n=118):
    t = txt(t)
    if len(t) <= n: return t
    cut = t[:n]
    for sep in ('. ', ': ', '; ', ', '):
        i = cut.rfind(sep)
        if i > 60: return cut[:i + (1 if sep == '. ' else 0)].rstrip(',;:') + ('' if sep == '. ' else '…')
    return cut.rsplit(' ', 1)[0] + '…'

cards = []
learn = src('learn.html')
toc = re.findall(r'<li><a href="/learn/([a-z-]+)/">(.*?)</a></li>', learn)
for i, (cid, title) in enumerate(toc):
    body = re.search(rf'<section class="chapter" id="ch-{cid}">(.*?)</section>', learn, re.S).group(1)
    p = re.search(r'<p>(.*?)</p>', body, re.S)
    sub = short(p.group(1)) if p else ''
    if cid == 'glossary': sub = 'Every mixing and mastering term on MasterScope, in plain English.'
    if cid == 'sounds-worse-on-spotify': sub = 'Quieter, duller or crunchier than in your DAW? The causes, and a checklist to fix it.'
    if cid == 'reference-loudness': sub = 'Measure any song on Spotify or YouTube and use its loudness and density as your target.'
    if cid == 'how-loud-to-master': sub = 'LUFS for Spotify, Apple Music, YouTube, SoundCloud and the club, and why −14 isn\'t a target.'
    cards.append((f'learn-{cid}', f'Learn · {i + 1:02d}', txt(title), sub))
cards.append(('learn', 'Learn', 'Learn mixing and mastering for streaming', 'A plain-English guide to loudness, peaks, density, tone, limiting and delivery.'))
cards.append(('liminal', 'Liminal · free VST3 and AU', 'The mastering limiter that lands on your target.', 'Press Learn, play your song once. Checked through real streaming encoders.'))
cards.append(('liminal-guide', 'Liminal · user guide', 'How to use Liminal', 'Install, Learn and targets, codec-safe ceilings, every control, Optimise and the release pack.'))
cards.append(('meter', 'MasterScope Meter · free app', 'How loud is the music you\'re up against?', 'Measure any song on Spotify or YouTube: loudness, peaks, density, and what streaming does to it.'))
cards.append(('about', 'About', 'Made so anyone can learn to master.', 'Free tools and a free guide for finishing music that holds its own.'))
cards.append(('changelog', "What's new", "What's new in MasterScope and Liminal", 'Every update to the analyser, the Learn guide and the Liminal plug-in.'))
cards.append(('coming-soon', 'Coming soon', 'More free tools are on the way.', 'New plug-ins in development from the makers of MasterScope, Liminal and Meter.'))
cards.append(('press', 'Press kit', 'Liminal and MasterScope: press kit', 'Descriptions, facts, screenshots and logos, free to use in coverage and listings.'))
cards.append(('advertise', 'Advertise', 'Reach people finishing and releasing music.', 'Labelled, useful sponsorships. No tracking pixels, no ad networks.'))

TEMPLATE = '''<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:1200px;height:630px;background:#07080f;overflow:hidden}
body{font-family:Inter,system-ui,sans-serif;color:#f4ede4;position:relative}
canvas{position:absolute;left:0;right:0;bottom:0;width:1200px;height:230px}
.in{position:absolute;inset:0;padding:56px 72px;display:flex;flex-direction:column}
.top{display:flex;align-items:center;justify-content:space-between}
.brand{display:flex;align-items:center;gap:14px;font-weight:700;font-size:28px;letter-spacing:-.01em}
.brand span{color:#a9b8ff}
.eyebrow{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:20px;letter-spacing:.1em;text-transform:uppercase;color:#fbb33c}
h1{margin:54px 0 0;font-size:var(--fs);line-height:1.02;letter-spacing:-.035em;font-weight:800;max-width:1000px}
p{margin:22px 0 0;font-size:27px;line-height:1.35;color:#c7bfb4;max-width:900px}
.dom{position:absolute;left:60px;bottom:30px;font-size:20px;color:#c7bfb4;font-weight:500;z-index:2;background:rgba(7,8,15,.88);padding:7px 12px;border-radius:9px}
</style></head><body><canvas id="c" width="2400" height="460"></canvas>
<div class="in"><div class="top"><div class="brand"><svg width="44" height="44" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#6f86ff"/><circle cx="32" cy="32" r="24" fill="#3d5afe"/><circle cx="32" cy="32" r="24" fill="none" stroke="#fff" stroke-width="3"/><path d="M32 2v10M32 52v10M2 32h10M52 32h10" stroke="#fff" stroke-width="3" stroke-linecap="round"/><path d="M13 34 L19 34 L23 23 L28 43 L33 17 L38 47 L42 27 L45 34 L51 34" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg><div>Master<span>Scope</span></div></div><div class="eyebrow">__EYEBROW__</div></div>
<h1 style="--fs:__FS__px">__TITLE__</h1><p>__SUB__</p></div><div class="dom">masterscope.gwstudio.com.au · Free tools for release-ready masters</div>
<script>
(()=>{const cv=document.getElementById('c'),g=cv.getContext('2d');g.scale(2,2);const W=1200,H=230,M=14,P=120,seed=__SEED__;
const S=[[27,31,94],[90,42,138],[176,58,110],[236,106,58],[251,179,60],[252,245,196]];
const heat=(t,a)=>{t=Math.max(0,Math.min(1,t))*(S.length-1);const i=Math.min(S.length-2,Math.floor(t)),f=t-i;const c=S[i].map((v,k)=>Math.round(v+(S[i+1][k]-v)*f));return `rgba(${c},${a})`};
for(let k=M-1;k>=0;k--){const d=k/(M-1),y0=H*(1.02-d*0.62),h=H*(0.42-d*0.16),x0=d*W*0.04,w=W-d*W*0.08;g.beginPath();g.moveTo(x0,y0);
for(let i=0;i<P;i++){const f=i/(P-1);const b=.5+.5*Math.sin(f*21+k*.7+seed)*Math.sin(f*5.3-k*.3-seed*.6);const v=Math.max(0,.3+.45*(1-f*.6)*b+.08*Math.sin(f*63+k*2.1+seed*1.7));g.lineTo(x0+f*w,y0-v*h);}
g.lineTo(x0+w,y0);g.closePath();g.fillStyle='#07080f';g.fill();g.lineWidth=1.8-d;g.strokeStyle=heat(.95-d*.85,(1-d*.6)*0.9);g.stroke();}})();
</script></body></html>'''

out = os.path.join(HERE, 'og'); os.makedirs(out, exist_ok=True)
with sync_playwright() as pw:
    b = pw.chromium.launch(); pg = b.new_page(viewport={'width': 1200, 'height': 630})
    pg.on('pageerror', lambda e: print('ERR', e)); pg.on('console', lambda m: print('LOG', m.text))
    for n, (slug, eb, title, sub) in enumerate(cards):
        fs = 76 if len(title) <= 34 else 66 if len(title) <= 52 else 58
        h = (TEMPLATE.replace('__EYEBROW__', html.escape(eb)).replace('__TITLE__', html.escape(title))
             .replace('__SUB__', html.escape(sub)).replace('__FS__', str(fs)).replace('__SEED__', str(1.3 * n + 0.4)))
        pg.set_content(h); pg.wait_for_timeout(150)
        pg.screenshot(path=os.path.join(out, slug + '.jpg'), type='jpeg', quality=88)
    b.close()
print(len(cards), 'share images in', out)
