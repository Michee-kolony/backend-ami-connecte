const mongoose = require('mongoose');
const { auteurSchema, versJson, dateJour } = require('./commun');
const { validationEpi } = require('./validationEpi');
const { TYPES_EVENEMENT, PRIORITES, STATUTS_EVENEMENT } = require('../config/epidemiologie');

const sansId = { _id: false };
const positif = { type: Number, min: 0, default: null };

/** Formulaire C — investigation d'un événement (§5.5). */
const investigationSchema = new mongoose.Schema({
  debut: dateJour(),
  equipe: { type: String, default: '', trim: true },
  responsable: { type: String, default: '', trim: true },
  hypothese: { type: String, default: '', trim: true },
  personnesInterrogees: positif,
  personnesExposees: positif,
  resultatsPrelevements: { type: String, default: '', trim: true },
  mesuresImmediates: { type: String, default: '', trim: true },
  besoinsMedicaments: { type: String, default: '', trim: true },
  besoinsPersonnel: { type: String, default: '', trim: true },
  recommandations: { type: String, default: '', trim: true },
  rapport: { type: String, default: '', trim: true },
  transmissionRapport: dateJour(),
  conclusion: { type: String, default: '', trim: true },
  par: { type: auteurSchema, default: undefined },
  le: { type: Date, default: null },
}, sansId);

/** Point de suivi de l'événement (évolution des cas et décès, mesures prises). */
const suiviSchema = new mongoose.Schema({
  date: dateJour(true),
  cas: positif,
  deces: positif,
  observation: { type: String, default: '', trim: true },
  par: { type: auteurSchema, required: true },
  le: { type: Date, default: Date.now },
}, sansId);

/**
 * Sous-fenêtre 5, formulaire A — notification d'un événement sanitaire. Une notification n'est
 * pas un cas confirmé : les cas sont enregistrés à part (CasSurveillance) avec leur classification.
 * `etat` suit l'événement (nouveau → clôturé) ; `statut` (greffon) suit la validation des données.
 */
const evenementSchema = new mongoose.Schema({
  numero: { type: String, required: true, unique: true },
  type: { type: String, enum: TYPES_EVENEMENT, required: true },
  maladie: { type: String, required: true },
  dateDebut: dateJour(),
  dateNotification: { type: Date, default: Date.now },
  entiteCode: { type: String, required: true, index: true },
  etablissementId: { type: String, default: null },
  casSignales: { type: Number, min: 0, required: true },
  decesSignales: { type: Number, min: 0, required: true },
  description: { type: String, required: true, trim: true },
  document: { type: String, default: '', trim: true },
  priorite: { type: String, enum: PRIORITES, required: true },
  etat: { type: String, enum: STATUTS_EVENEMENT, default: 'Nouveau', index: true },
  investigation: { type: investigationSchema, default: undefined },
  suivis: { type: [suiviSchema], default: [] },
  clotureLe: { type: Date, default: null },
}, { timestamps: true, toJSON: { transform: versJson } });

evenementSchema.plugin(validationEpi, { champs: ['type', 'maladie', 'dateDebut', 'entiteCode', 'casSignales', 'decesSignales', 'description', 'priorite', 'etat'] });

module.exports = mongoose.model('EvenementSanitaire', evenementSchema, 'epi_evenements');
