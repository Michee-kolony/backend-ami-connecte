const mongoose = require('mongoose');
const { versJson } = require('./commun');
const { validationEpi } = require('./validationEpi');

const sansId = { _id: false };

/**
 * Sous-fenêtre 3 — calcul des populations cibles d'une entité pour une année. Le calcul enregistre
 * la population et les coefficients (avec leur version) réellement utilisés, la formule et les
 * valeurs : il est reproductible. Toute modification de la population ou d'un coefficient produit
 * une nouvelle version du calcul ; les anciennes restent consultables.
 */
const calculSchema = new mongoose.Schema({
  numero: { type: String, required: true, unique: true },
  entiteCode: { type: String, required: true, index: true },
  annee: { type: Number, required: true },
  population: {
    type: new mongoose.Schema({ id: String, version: Number, totale: Number, hommes: Number, femmes: Number, nature: String, source: String }, sansId),
    required: true,
  },
  resultats: {
    type: [new mongoose.Schema({
      cible: String, libelle: String, coefficientCode: String, coefficientVersion: Number, coefficientId: String,
      valeurPct: Number, formule: String, valeurBrute: Number, valeur: Number,
    }, sansId)],
    default: [],
  },
  /** Cibles par âge et par sexe reprises du référentiel (calcul par âge / sexe). */
  parAge: { type: [new mongoose.Schema({ code: String, libelle: String, effectif: Number }, sansId)], default: [] },
  arrondi: { type: String, default: '' },
  /** Cibles absentes : coefficient validé introuvable pour ce territoire et cette période. */
  manquantes: { type: [String], default: [] },
  simulation: { type: Boolean, default: false },
}, { timestamps: true, toJSON: { transform: versJson } });

calculSchema.plugin(validationEpi, { champs: ['resultats'] });
calculSchema.index({ entiteCode: 1, annee: 1, version: 1 });

/** Valeur d'une population cible (null si absente). */
calculSchema.methods.cible = function (code) {
  return this.resultats.find((r) => r.cible === code)?.valeur ?? null;
};

module.exports = mongoose.model('CalculCible', calculSchema, 'epi_calculs');
