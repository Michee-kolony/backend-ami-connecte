// Domaine de l'espace administrateur (tableau de bord des médecins), utilisé par le QR code des
// cartes patientes générées hors du tableau de bord (application mobile). Ordre : APP_URL si elle
// désigne un vrai domaine, sinon le dernier domaine d'où un soignant s'est connecté ou a imprimé
// une carte (mémorisé en base), sinon APP_URL / localhost (développement).
const mongoose = require('mongoose');

const Parametre = mongoose.models.Parametre || mongoose.model('Parametre', new mongoose.Schema({
  cle: { type: String, required: true, unique: true },
  valeur: { type: String, default: '' },
}, { timestamps: true }));

const CLE = 'domaineAdmin';
const LOCAL = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+)$/;

/** « https://domaine » d'une adresse http(s) publique, sinon null (absente, douteuse ou locale). */
function originePublique(valeur) {
  try {
    const u = new URL(valeur);
    return ['http:', 'https:'].includes(u.protocol) && !LOCAL.test(u.hostname) ? u.origin : null;
  } catch {
    return null;
  }
}

/** Mémorise le domaine du tableau de bord (appelé après authentification d'un soignant). */
async function memoriser(valeur) {
  const origine = originePublique(valeur);
  if (!origine) return;
  try {
    await Parametre.updateOne({ cle: CLE, valeur: { $ne: origine } }, { $set: { valeur: origine } }, { upsert: true });
  } catch (err) {
    if (err?.code !== 11000) throw err; // déjà à jour (course entre deux connexions)
  }
}

async function domaineAdmin() {
  const configure = originePublique(process.env.APP_URL);
  if (configure) return configure;
  const memorise = await Parametre.findOne({ cle: CLE }).lean();
  return memorise?.valeur || process.env.APP_URL || 'http://localhost:4200';
}

module.exports = { memoriser, domaineAdmin, originePublique };
