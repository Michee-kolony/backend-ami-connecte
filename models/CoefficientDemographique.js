const mongoose = require('mongoose');
const { versJson, dateJour } = require('./commun');
const { validationEpi } = require('./validationEpi');
const { PROGRAMMES, CIBLES } = require('../config/epidemiologie');

/**
 * Sous-fenêtre 2 — coefficient démographique administrable, documenté, versionné et validé.
 * `code` identifie le paramètre (DEM-001…) ; chaque version est un document. Un coefficient
 * validé n'est jamais modifié : une nouvelle version est créée, l'ancienne reste pour les calculs
 * historiques. Territoire : entité géographique (national, provincial ou local).
 */
const coefficientSchema = new mongoose.Schema({
  code: { type: String, required: true, index: true, trim: true, uppercase: true },
  nom: { type: String, required: true, trim: true },
  /** Population cible produite (FE, NA, NS…). */
  cible: { type: String, enum: Object.keys(CIBLES), required: true },
  populationReference: { type: String, default: 'Population totale', trim: true },
  /** Valeur en pourcentage (4 = 4 %) ; la valeur décimale (0,04) est dérivée. */
  valeurPct: { type: Number, required: true, min: 0, max: 100 },
  entiteCode: { type: String, required: true, default: 'CD' },
  programme: { type: String, enum: PROGRAMMES, default: 'Autre' },
  dateDebut: dateJour(true),
  dateFin: dateJour(),
  source: { type: String, default: '', trim: true },
  commentaire: { type: String, default: '', trim: true },
}, { timestamps: true, toJSON: { transform: (doc, ret) => { versJson(doc, ret); ret.valeurDecimale = Math.round(ret.valeurPct * 1e6) / 1e8; return ret; } } });

coefficientSchema.plugin(validationEpi, { champs: ['nom', 'cible', 'populationReference', 'valeurPct', 'entiteCode', 'programme', 'dateDebut', 'dateFin', 'source', 'commentaire'] });
coefficientSchema.index({ code: 1, version: 1 }, { unique: true });

/** Conversion du pourcentage en coefficient numérique : 4 % = 0,04. */
coefficientSchema.virtual('decimal').get(function () { return this.valeurPct / 100; });

module.exports = mongoose.model('CoefficientDemographique', coefficientSchema, 'epi_coefficients');
