const mongoose = require('mongoose');
const { auteurSchema, versJson, dateJour } = require('./commun');
const stockage = require('../config/r2');

const SEXES = ['Féminin', 'Masculin', 'Indéterminé'];
const PRESENTATIONS = ['Céphalique', 'Siège', 'Transverse', 'Oblique'];
const QUANTITES_LIQUIDE = ['Normale', 'Oligoamnios', 'Hydramnios'];
const MATURITES_PLACENTA = ['Grade 0', 'Grade I', 'Grade II', 'Grade III'];
const FOETUS_MAX = 4;

/** Choix facultatif dans une liste ('' = non renseigné). */
const choix = (valeurs) => ({ type: String, enum: [...valeurs, ''], default: '' });
const mesure = (max) => ({ type: Number, min: 0, max, default: null });

/** Un fœtus : activité cardiaque, BCF (bpm), sexe (F1, F2…), présentation, position et biométrie (mm, g). */
const foetusSchema = new mongoose.Schema({
  activiteCardiaque: { type: Boolean, default: null },
  bcf: mesure(250),
  sexe: choix(SEXES),
  presentation: choix(PRESENTATIONS),
  position: { type: String, default: '', trim: true, maxlength: 120 },
  bipMm: mesure(150),
  perimetreCranienMm: mesure(500),
  perimetreAbdominalMm: mesure(500),
  longueurFemoraleMm: mesure(120),
  poidsEstimeG: mesure(7000),
}, { _id: false });

/** Compte rendu ou image : objet privé du bucket R2, servi par lien signé temporaire. */
const fichierSchema = new mongoose.Schema({
  cle: { type: String, required: true },
  type: { type: String, required: true },
  nom: { type: String, default: '', trim: true },
}, { _id: false });

/**
 * Échographie obstétricale d'une grossesse (rubriques de la fiche du médecin) : date et motif,
 * âge gestationnel, fœtus, placenta, liquide amniotique, col, anomalies, conclusion, praticien
 * et compte rendu ou images joints. Réservée aux médecins ; les fichiers ne sont jamais publics.
 */
const echographieSchema = new mongoose.Schema({
  patienteId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patiente', required: true, index: true },
  grossesseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Grossesse', required: true, index: true },
  etablissementId: { type: String, default: null },

  date: dateJour(true),
  motif: { type: String, default: '', trim: true, maxlength: 300 },
  agSemaines: { type: Number, min: 0, max: 44, default: null },
  agJours: { type: Number, min: 0, max: 6, default: null },
  nombreFoetus: { type: Number, min: 1, max: FOETUS_MAX, default: 1 },
  foetus: {
    type: [foetusSchema],
    default: [],
    validate: { validator: (f) => f.length <= FOETUS_MAX, message: `${FOETUS_MAX} fœtus au maximum.` },
  },
  placenta: {
    localisation: { type: String, default: '', trim: true, maxlength: 120 },
    aspect: { type: String, default: '', trim: true, maxlength: 200 },
    maturite: choix(MATURITES_PLACENTA),
  },
  liquideAmniotique: {
    quantite: choix(QUANTITES_LIQUIDE),
    /** Index amniotique (cm), si mesuré. */
    indiceCm: mesure(50),
  },
  col: {
    longueurMm: mesure(80),
    aspect: { type: String, default: '', trim: true, maxlength: 200 },
  },
  anomalies: { type: String, default: '', trim: true, maxlength: 2000 },
  conclusion: { type: String, default: '', trim: true, maxlength: 2000 },
  /** Praticien qui a réalisé l'échographie (peut être extérieur à la plateforme). */
  praticien: { type: String, default: '', trim: true, maxlength: 160 },
  fichiers: { type: [fichierSchema], default: [] },

  auteur: { type: auteurSchema, required: true },
}, { timestamps: true, toJSON: { transform: versJson } });

echographieSchema.index({ grossesseId: 1, date: -1 });

/** Vue pour le médecin : fichiers servis par liens signés (15 min), clés jamais exposées. */
echographieSchema.methods.vue = async function () {
  const json = this.toJSON();
  return {
    ...json,
    fichiers: await Promise.all(this.fichiers.map(async (f) => ({ type: f.type, nom: f.nom, url: await stockage.urlSignee(f.cle) }))),
  };
};

module.exports = mongoose.model('Echographie', echographieSchema);
module.exports.SEXES = SEXES;
module.exports.PRESENTATIONS = PRESENTATIONS;
module.exports.QUANTITES_LIQUIDE = QUANTITES_LIQUIDE;
module.exports.MATURITES_PLACENTA = MATURITES_PLACENTA;
module.exports.FOETUS_MAX = FOETUS_MAX;
