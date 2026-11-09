const mongoose = require('mongoose');
const { versJson, dateJour } = require('./commun');
const { validationEpi } = require('./validationEpi');
const { RESULTATS_LABO, CLASSIFICATIONS_CAS, ISSUES_CAS, SEXES } = require('../config/epidemiologie');

/**
 * Sous-fenêtre 5, formulaire B — cas de surveillance (suspect, probable, confirmé). La référence
 * au dossier AMI est sécurisée : elle n'est montrée qu'au personnel de l'établissement du cas et
 * jamais dans les agrégats. Pas de nom ni de téléphone ici.
 */
const casSchema = new mongoose.Schema({
  numero: { type: String, required: true, unique: true },
  evenementNumero: { type: String, default: null, index: true },
  /** Dossier AMI lié (patiente ou enfant), si applicable. */
  personne: {
    type: new mongoose.Schema({ type: { type: String, enum: ['Patiente', 'Enfant'] }, id: String, numero: String }, { _id: false }),
    default: undefined,
  },
  ageAnnees: { type: Number, min: 0, max: 130, default: null },
  ageMois: { type: Number, min: 0, max: 11, default: null },
  dateNaissance: dateJour(),
  sexe: { type: String, enum: SEXES, required: true },
  entiteCode: { type: String, required: true, index: true },
  etablissementId: { type: String, default: null },
  maladie: { type: String, required: true, index: true },
  dateDebutSymptomes: dateJour(),
  dateConsultation: dateJour(),
  datePrelevement: dateJour(),
  resultatLabo: { type: String, enum: RESULTATS_LABO, default: 'Non réalisé' },
  classification: { type: String, enum: CLASSIFICATIONS_CAS, required: true },
  issue: { type: String, enum: ISSUES_CAS, default: 'En cours' },
  dateCloture: dateJour(),
}, { timestamps: true, toJSON: { transform: versJson } });

casSchema.plugin(validationEpi, { champs: ['classification', 'resultatLabo', 'issue', 'dateCloture', 'maladie', 'entiteCode', 'sexe', 'ageAnnees'] });

/** Date de référence épidémiologique : début des symptômes, sinon consultation, sinon saisie. */
casSchema.methods.dateReference = function () {
  return this.dateDebutSymptomes || this.dateConsultation || this.createdAt?.toISOString().slice(0, 10);
};

module.exports = mongoose.model('CasSurveillance', casSchema, 'epi_cas');
