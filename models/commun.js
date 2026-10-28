// Éléments partagés par les modèles du suivi prénatal.
const crypto = require('crypto');
const mongoose = require('mongoose');

/** Professionnel figé au moment de l'acte (conservé même si son compte change ou disparaît). */
const auteurSchema = new mongoose.Schema({
  id: { type: String, required: true },
  nom: { type: String, required: true },
  role: { type: String, required: true },
  matricule: { type: String, default: '' },
}, { _id: false });

/** Instantané du soignant connecté (req.soignant) : l'auteur vient toujours de la session. */
function auteurDe(soignant) {
  return { id: soignant.id, nom: `${soignant.prenom} ${soignant.nom}`, role: soignant.role, matricule: soignant.matricule };
}

/** Transformation JSON commune : id lisible, sans _id ni __v. */
function versJson(doc, ret) {
  ret.id = String(ret._id);
  delete ret._id;
  delete ret.__v;
  return ret;
}

/** Date « AAAA-MM-JJ » (dates cliniques sans heure : DDR, DPA, naissance). */
const DATE_JOUR = /^\d{4}-\d{2}-\d{2}$/;
const dateJour = (requis = false) => ({
  type: String,
  required: requis,
  default: requis ? undefined : null,
  validate: { validator: (v) => v == null || (DATE_JOUR.test(v) && !Number.isNaN(Date.parse(v))), message: 'Date invalide (AAAA-MM-JJ attendu).' },
});

/**
 * Matricule attribué par le serveur : préfixe + 6 chiffres tirés au hasard (CHF-482913,
 * RECO-731065), jamais saisi. Non séquentiel : il ne révèle pas le nombre de comptes et ne se
 * devine pas à partir d'un autre. Un tirage déjà attribué est refait.
 */
async function matriculeAleatoire(Modele, prefixe) {
  for (let essai = 0; essai < 20; essai += 1) {
    const matricule = `${prefixe}-${crypto.randomInt(100000, 1000000)}`;
    if (!(await Modele.exists({ matricule }))) return matricule;
  }
  throw new Error(`Aucun matricule ${prefixe} libre après 20 tirages.`);
}

/**
 * Premier enregistrement d'un compte avec un matricule aléatoire. Si deux créations simultanées
 * tirent le même numéro, l'index unique refuse la seconde : elle est refaite avec un autre tirage.
 */
async function enregistrerAvecMatricule(doc, prefixe) {
  for (let essai = 0; essai < 5; essai += 1) {
    doc.matricule = await matriculeAleatoire(doc.constructor, prefixe);
    try {
      return await doc.save();
    } catch (err) {
      if (err.code !== 11000 || !err.keyPattern?.matricule) throw err;
    }
  }
  throw new Error(`Matricule ${prefixe} impossible à attribuer.`);
}

module.exports = { auteurSchema, auteurDe, versJson, dateJour, DATE_JOUR, matriculeAleatoire, enregistrerAvecMatricule };
