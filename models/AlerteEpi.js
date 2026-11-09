const mongoose = require('mongoose');
const { auteurSchema, versJson, dateJour } = require('./commun');
const { DOMAINES_ALERTE, PRIORITES, STATUTS_ALERTE } = require('../config/epidemiologie');

const sansId = { _id: false };

/**
 * Sous-fenêtre 8, formulaire B — alerte et son traitement : problème identifié, responsable,
 * échéance, action corrective, preuve et résultat. Une alerte générée automatiquement indique la
 * donnée et la règle qui l'ont déclenchée ; `cle` évite les alertes répétitives (une seule alerte
 * ouverte par problème, les répétitions incrémentent `occurrences`).
 */
const alerteSchema = new mongoose.Schema({
  numero: { type: String, required: true, unique: true },
  cle: { type: String, required: true, index: true },
  domaine: { type: String, enum: DOMAINES_ALERTE, required: true },
  titre: { type: String, required: true },
  message: { type: String, default: '' },
  actionRecommandee: { type: String, default: '' },
  priorite: { type: String, enum: PRIORITES, required: true },
  entiteCode: { type: String, default: null, index: true },
  territoire: { type: String, default: '' },
  periode: { type: String, default: '' },
  /** Donnée et règle à l'origine de l'alerte. */
  declencheur: {
    type: new mongoose.Schema({
      automatique: Boolean, regleCode: String, regleVersion: Number, indicateur: String, valeur: Number, seuil: Number, operateur: String, donnee: String,
    }, sansId),
    default: undefined,
  },
  occurrences: { type: Number, default: 1 },
  derniereOccurrence: { type: Date, default: Date.now },
  /** Alerte répétée reliée à un problème déjà identifié. */
  problemeLie: { type: String, default: null },
  statut: { type: String, enum: STATUTS_ALERTE, default: 'Nouvelle', index: true },
  responsable: { type: new mongoose.Schema({ id: String, nom: String, fonction: String }, sansId), default: undefined },
  echeance: dateJour(),
  diagnostic: { type: String, default: '', trim: true },
  actionCorrective: { type: String, default: '', trim: true },
  datePrevue: dateJour(),
  dateRealisation: dateJour(),
  preuve: { type: String, default: '', trim: true },
  resultat: { type: String, default: '', trim: true },
  evaluation: { type: String, default: '', trim: true },
  resolueLe: { type: Date, default: null },
  clotureLe: { type: Date, default: null },
  creePar: { type: auteurSchema, default: undefined },
  historique: {
    type: [new mongoose.Schema({ action: String, ancienStatut: String, nouveauStatut: String, details: String, par: auteurSchema, le: Date }, sansId)],
    default: [],
  },
}, { timestamps: true, toJSON: { transform: versJson } });

module.exports = mongoose.model('AlerteEpi', alerteSchema, 'epi_alertes');
