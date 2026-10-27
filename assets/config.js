/* MasterScope site settings: fill these in to switch features on. Used by every page. */
window.MS_SITE = {
  version: '1.0',
  contactEmail: '',          // shown on the Advertise and Privacy pages, e.g. 'hello@yourdomain'
  analytics: null,           // { provider: 'plausible', domain: 'masterscope.gwstudio.com.au' } for cookie-free visit counts
  // Sponsors appear only when set. Each: { name, text, url, cta } (cta optional). Keys are the places they appear:
  //   result (under What to work on), release (under Release ready), card (on shared master cards: "presented by")
  //   learn: { '<chapter id>': {...} } for a sponsor on one Learn chapter
  sponsors: { result: null, release: null, card: null, learn: {} },
};
