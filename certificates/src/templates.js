// Built-in document designs. Every value passed in is already HTML-escaped.

const sig = (name, title) => (name || title)
    ? `<div class="sig"><div class="sig-line"></div><div class="sig-name">${name}</div><div class="sig-title">${title}</div></div>`
    : '';

const signatures = (d) => {
    const s = sig(d.signature1Name, d.signature1Title) + sig(d.signature2Name, d.signature2Title);
    return s ? `<div class="sigs">${s}</div>` : '';
};

const logo = (d) => (d.logoUrl ? `<img class="logo" src="${d.logoUrl}" alt="">` : '');

const verify = (d) => {
    if (!d.qrDataUrl && !d.certificateId) return '';
    return `<div class="verify">${d.qrDataUrl ? `<img src="${d.qrDataUrl}" alt="">` : ''}${d.certificateId ? `<div>ID: ${d.certificateId}</div>` : ''}</div>`;
};

const base = `
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: 100%; height: 100%; }
body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.page { position: relative; width: 100vw; height: 100vh; overflow: hidden; }
.sigs { display: flex; justify-content: center; gap: 28mm; }
.sig { text-align: center; min-width: 55mm; }
.sig-line { border-top: 0.4mm solid currentColor; opacity: .6; margin-bottom: 2mm; }
.sig-name { font-weight: 600; font-size: 11pt; }
.sig-title { font-size: 9pt; opacity: .75; }
.verify { position: absolute; right: 20mm; bottom: 17mm; text-align: center; font: 7pt 'Montserrat', sans-serif; opacity: .85; }
.verify img { width: 20mm; height: 20mm; display: block; margin: 0 auto 1mm; }
.logo { max-height: 20mm; max-width: 60mm; object-fit: contain; }
`;

export const TEMPLATES = {
    'certificate-classic': {
        label: 'Classic certificate',
        css: (a) => `${base}
body { font-family: 'Lora', serif; color: #2b2b2b; background: #fffdf7; }
.page { padding: 12mm; }
.frame { position: absolute; inset: 10mm; border: 1.6mm solid ${a}; }
.frame::after { content: ''; position: absolute; inset: 2.5mm; border: 0.4mm solid ${a}; opacity: .6; }
.content { position: relative; height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 14mm 26mm; gap: 4mm; }
.title { font-family: 'Playfair Display', serif; font-size: 40pt; font-weight: 700; letter-spacing: 1.5mm; text-transform: uppercase; color: ${a}; }
.subtitle { font-size: 13pt; letter-spacing: .6mm; text-transform: uppercase; opacity: .8; }
.name { font-family: 'Great Vibes', cursive; font-size: 52pt; line-height: 1.15; margin: 2mm 0; }
.body { font-size: 13pt; max-width: 200mm; line-height: 1.5; }
.meta { font-size: 11pt; opacity: .8; }
.sigs { margin-top: 8mm; }`,
        html: (d) => `<div class="page"><div class="frame"></div><div class="content">
${logo(d)}<div class="title">${d.title}</div><div class="subtitle">${d.subtitle}</div>
<div class="name">${d.name}</div><div class="body">${d.body}</div>
<div class="meta">${[d.date, d.issuer].filter(Boolean).join(' · ')}</div>${signatures(d)}</div>${verify(d)}</div>`,
    },

    'certificate-modern': {
        label: 'Modern certificate',
        css: (a) => `${base}
body { font-family: 'Montserrat', sans-serif; color: #1f2430; background: #fff; }
.band { position: absolute; left: 0; top: 0; bottom: 0; width: 62mm; background: ${a}; }
.band::after { content: ''; position: absolute; right: -18mm; top: 0; bottom: 0; width: 36mm; background: ${a}; opacity: .25; }
.content { position: absolute; left: 92mm; right: 18mm; top: 0; bottom: 0; display: flex; flex-direction: column; justify-content: center; gap: 4mm; }
.logo { margin-bottom: 4mm; align-self: flex-start; }
.title { font-size: 34pt; font-weight: 700; text-transform: uppercase; letter-spacing: .8mm; }
.subtitle { font-size: 12pt; font-weight: 600; color: ${a}; text-transform: uppercase; letter-spacing: .5mm; }
.name { font-size: 36pt; font-weight: 700; color: ${a}; margin: 4mm 0 2mm; line-height: 1.1; }
.body { font-size: 12pt; line-height: 1.6; max-width: 165mm; }
.meta { font-size: 10pt; opacity: .7; }
.sigs { justify-content: flex-start; margin-top: 10mm; }`,
        html: (d) => `<div class="page"><div class="band"></div><div class="content">
${logo(d)}<div class="title">${d.title}</div><div class="subtitle">${d.subtitle}</div>
<div class="name">${d.name}</div><div class="body">${d.body}</div>
<div class="meta">${[d.date, d.issuer].filter(Boolean).join(' · ')}</div>${signatures(d)}</div>${verify(d)}</div>`,
    },

    'diploma-kids': {
        label: 'Kids diploma',
        css: (a) => `${base}
body { font-family: 'Montserrat', sans-serif; color: #243046; background: #fff; }
.page { background:
  radial-gradient(circle at 8% 12%, ${a}33 0 16mm, transparent 16.2mm),
  radial-gradient(circle at 94% 88%, #ffb30033 0 22mm, transparent 22.2mm),
  radial-gradient(circle at 90% 10%, #00c2a833 0 10mm, transparent 10.2mm),
  radial-gradient(circle at 6% 90%, #ff5c8a33 0 12mm, transparent 12.2mm), #fff; }
.frame { position: absolute; inset: 9mm; border: 1.2mm dashed ${a}; border-radius: 8mm; }
.content { position: relative; height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 16mm 28mm; gap: 3.5mm; }
.stars { font-size: 20pt; letter-spacing: 3mm; color: #ffb300; }
.title { font-size: 44pt; font-weight: 700; color: ${a}; text-transform: uppercase; letter-spacing: 1mm; }
.subtitle { font-size: 13pt; font-weight: 600; }
.name { font-family: 'Great Vibes', cursive; font-size: 50pt; color: #243046; line-height: 1.15; }
.body { font-size: 13pt; line-height: 1.5; max-width: 200mm; }
.meta { font-size: 11pt; opacity: .75; }
.sigs { margin-top: 6mm; }`,
        html: (d) => `<div class="page"><div class="frame"></div><div class="content">
${logo(d)}<div class="stars">★ ★ ★</div><div class="title">${d.title}</div><div class="subtitle">${d.subtitle}</div>
<div class="name">${d.name}</div><div class="body">${d.body}</div>
<div class="meta">${[d.date, d.issuer].filter(Boolean).join(' · ')}</div>${signatures(d)}</div>${verify(d)}</div>`,
    },
};
