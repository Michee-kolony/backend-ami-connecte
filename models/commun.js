// Éléments partagés par les modèles du suivi prénatal.
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

module.exports = { auteurSchema, auteurDe, versJson, dateJour, DATE_JOUR };
