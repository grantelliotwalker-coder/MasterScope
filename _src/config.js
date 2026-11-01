/* MasterScope site settings: fill these in to switch features on. Used by every page. */
window.MS_SITE = {
  version: '1.0',
  contactEmail: 'masterscope@gwstudio.com.au',   // shown on the Advertise, Privacy, About and Terms pages and in the footer
  analytics: { provider: 'cloudflare', token: '65b3b22b11304b2d9283321a9b1d51fa' },   // cookie-free visit counts. Free: { provider: 'cloudflare', token: '<token from Cloudflare Web Analytics>' }
                             // Paid: { provider: 'plausible', domain: 'masterscope.gwstudio.com.au' }
  // Sponsors appear only when set. Each: { name, text, url, cta } (cta optional). Keys are the places they appear:
  //   result (under What to work on), release (under Release ready), card (on shared master cards: "presented by")
  //   learn: { '<chapter id>': {...} } for a sponsor on one Learn chapter
  sponsors: { result: null, release: null, card: null, learn: {} },
};
