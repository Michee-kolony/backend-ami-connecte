// Chiffrement des messages au repos (AES-256-GCM : confidentialité + intégrité).
// Clé : CHAT_CLE (32 octets en base64, ex. `openssl rand -base64 32`). À défaut, une clé est
// dérivée de JWT_SECRET (HKDF) — à éviter en production : changer JWT_SECRET rendrait alors
// les anciens messages illisibles.
const crypto = require('crypto');

let cle = null;

function cleDeChiffrement() {
  if (cle) return cle;
  if (process.env.CHAT_CLE) {
    cle = Buffer.from(process.env.CHAT_CLE, 'base64');
    if (cle.length !== 32) throw new Error('CHAT_CLE doit contenir 32 octets encodés en base64.');
  } else {
    if (!process.env.JWT_SECRET) throw new Error('CHAT_CLE ou JWT_SECRET requis pour chiffrer les discussions.');
    console.warn('CHAT_CLE absente : clé des discussions dérivée de JWT_SECRET (à configurer en production).');
    cle = Buffer.from(crypto.hkdfSync('sha256', process.env.JWT_SECRET, 'ami-connecte', 'discussions-soignants-v1', 32));
  }
  return cle;
}

/** Texte → { iv, tag, d } (base64). Un IV aléatoire par message. */
function chiffrer(texte) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', cleDeChiffrement(), iv);
  const d = Buffer.concat([c.update(String(texte), 'utf8'), c.final()]);
  return { v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), d: d.toString('base64') };
}

/** { iv, tag, d } → texte ; null si le contenu a été altéré ou la clé a changé. */
function dechiffrer(contenu) {
  try {
    const dc = crypto.createDecipheriv('aes-256-gcm', cleDeChiffrement(), Buffer.from(contenu.iv, 'base64'));
    dc.setAuthTag(Buffer.from(contenu.tag, 'base64'));
    return Buffer.concat([dc.update(Buffer.from(contenu.d, 'base64')), dc.final()]).toString('utf8');
  } catch {
    return null;
  }
}

module.exports = { chiffrer, dechiffrer };
