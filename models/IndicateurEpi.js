const mongoose = require('mongoose');
const { versJson } = require('./commun');
const { validationEpi } = require('./validationEpi');
const { UNITES_INDICATEUR, PERIODICITES, CIBLES } = require('../config/epidemiologie');

/**
 * Sous-fenêtre 7 — fiche technique d'un indicateur de couverture (catalogue central des
 * indicateurs) : numérateur et dénominateur définis séparément, source, désagrégation, seuil.
 * Toute modification crée une nouvelle version soumise à validation (test T20).
 */
const indicateurSchema = new mongoose.Schema({
  code: { type: String, required: true, index: true },
  nom: { type: String, required: true, trim: true },
  intervention: { type: String, required: true },
  /** Code de réalisation calculé dans les modules AMI (config/moteurEpidemiologie.js). */
  realisation: { type: String, required: true },
  numerateur: { type: String, required: true, trim: true },
  /** Dénominateur : population cible de la sous-fenêtre 3. */
  cible: { type: String, enum: Object.keys(CIBLES), required: true },
  unite: { type: String, enum: UNITES_INDICATEUR, default: 'Pourcentage' },
  periodicite: { type: String, enum: PERIODICITES, default: 'Mensuelle' },
  source: { type: String, default: 'Modules AMI', trim: true },
  desagregation: { type: [String], default: ['Territoire', 'Structure'] },
  seuilReference: { type: Number, min: 0, max: 1000, default: null },
  parametres: { type: mongoose.Schema.Types.Mixed, default: {} },
  referenceValidation: { type: String, default: '', trim: true },
}, { timestamps: true, toJSON: { transform: versJson } });

indicateurSchema.plugin(validationEpi, { champs: ['nom', 'numerateur', 'cible', 'unite', 'periodicite', 'source', 'desagregation', 'seuilReference', 'parametres'] });
indicateurSchema.index({ code: 1, version: 1 }, { unique: true });

module.exports = mongoose.model('IndicateurEpi', indicateurSchema, 'epi_indicateurs');
