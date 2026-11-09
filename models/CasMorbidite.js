const mongoose = require('mongoose');
const { versJson, dateJour } = require('./commun');
const { validationEpi } = require('./validationEpi');
const { SERVICES, CLASSIFICATIONS_MORBIDITE, ISSUES_MORBIDITE, SEXES } = require('../config/epidemiologie');

/**
 * Sous-fenêtre 6, formulaire A — cas de morbidité (épisode de maladie pris en charge).
 * Un épisode n'est compté qu'une fois : même dossier, même diagnostic, moins de 30 jours → doublon.
 */
const morbiditeSchema = new mongoose.Schema({
  numero: { type: String, required: true, unique: true },
  personne: {
    type: new mongoose.Schema({ type: { type: String, enum: ['Patiente', 'Enfant'] }, id: String, numero: String }, { _id: false }),
    default: undefined,
  },
  dateConsultation: dateJour(true),
  entiteCode: { type: String, required: true, index: true },
  etablissementId: { type: String, default: null },
  service: { type: String, enum: SERVICES, required: true },
  ageAnnees: { type: Number, min: 0, max: 130, required: true },
  sexe: { type: String, enum: SEXES, required: true },
  diagnostic: { type: String, required: true, index: true },
  classification: { type: String, enum: CLASSIFICATIONS_MORBIDITE, required: true },
  /** Morbidité maternelle (grossesse, accouchement, post-partum) ou néonatale / infantile. */
  categorie: { type: String, enum: ['Générale', 'Maternelle', 'Néonatale', 'Infantile'], default: 'Générale' },
  complication: { type: String, default: '', trim: true },
  issue: { type: String, enum: ISSUES_MORBIDITE, default: 'En cours' },
  dateSortie: dateJour(),
  /** Transfert depuis une autre structure : ne compte pas comme un nouveau cas. */
  transfertDe: { type: String, default: '', trim: true },
}, { timestamps: true, toJSON: { transform: versJson } });

morbiditeSchema.plugin(validationEpi, { champs: ['diagnostic', 'classification', 'categorie', 'complication', 'issue', 'dateSortie', 'service'] });

module.exports = mongoose.model('CasMorbidite', morbiditeSchema, 'epi_morbidite');
