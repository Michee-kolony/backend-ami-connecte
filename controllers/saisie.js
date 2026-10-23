// Lecture des formulaires cliniques (accouchement, nouveau-né) : chaque champ accepté est décrit
// dans une « spécification » et converti (jamais d'objet brut du client : protège des injections NoSQL).

/** Erreur HTTP transmise au gestionnaire d'erreurs d'app.js (details : renvoyés avec le message). */
const erreur = (status, message, details) => Object.assign(new Error(message), { status, details });

const texte = (v, max = 2000) => (v == null ? '' : String(v).trim().slice(0, max));
const nombre = (v) => (v === '' || v == null || typeof v === 'object' || Number.isNaN(Number(v)) ? null : Number(v));
const ouiNon = (v) => (v === true || v === 'true' ? true : v === false || v === 'false' ? false : null);
const objet = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

/** Instant (date et heure) ; null si vide, 400 si invalide. */
function instant(v, libelle = 'Date et heure') {
  if (v === '' || v == null) return null;
  const d = new Date(typeof v === 'object' ? NaN : v);
  if (Number.isNaN(d.getTime())) throw erreur(400, `${libelle} invalide.`);
  return d;
}

/** Jour AAAA-MM-JJ ; null si vide, 400 si invalide. */
function jour(v, libelle = 'Date') {
  if (v === '' || v == null) return null;
  const s = texte(v, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw erreur(400, `${libelle} invalide (AAAA-MM-JJ attendu).`);
  return s;
}

// Lecteurs de champ, à combiner dans une spécification { champ: lecteur | sous-spécification }.
const T = (max = 2000) => (v) => texte(v, max);
const N = (v) => nombre(v);
const B = (v) => ouiNon(v);
const C = (valeurs) => (v) => (valeurs.includes(v) ? v : '');
const D = (v) => instant(v);
const J = (v) => jour(v);

/** Champs présents dans `d`, convertis selon la spécification (les absents sont ignorés). */
function lire(spec, d) {
  const o = {};
  const source = objet(d);
  for (const [k, lecteur] of Object.entries(spec)) {
    if (source[k] === undefined) continue;
    o[k] = typeof lecteur === 'function' ? lecteur(source[k]) : lire(lecteur, source[k]);
  }
  return o;
}

/** Fusion profonde de valeurs lues dans un objet existant (mise à jour partielle). */
function fusionner(cible, source) {
  const r = { ...objet(cible) };
  for (const [k, v] of Object.entries(source)) {
    r[k] = v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) ? fusionner(r[k], v) : v;
  }
  return r;
}

/** Validation Mongoose → 400 avec le premier message lisible. */
function valider(doc) {
  return doc.validate().catch((err) => {
    throw erreur(400, Object.values(err.errors || {})[0]?.message || 'Données invalides.');
  });
}

/** Un acte clinique ne peut pas être daté dans le futur (5 min de tolérance d'horloge). */
function pasDansLeFutur(date, libelle) {
  if (date && date.getTime() > Date.now() + 5 * 60000) throw erreur(400, `${libelle} ne peut pas être dans le futur.`);
  return date;
}

module.exports = { erreur, texte, nombre, ouiNon, objet, instant, jour, T, N, B, C, D, J, lire, fusionner, valider, pasDansLeFutur };
