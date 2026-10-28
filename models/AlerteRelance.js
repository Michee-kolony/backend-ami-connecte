const mongoose = require('mongoose');
const { auteurSchema, versJson } = require('./commun');
const { ALERTES } = require('../config/relance');

/**
 * Alerte du module de relance (section 10). Les alertes similaires (même type, même
 * destinataire) sont regroupées tant qu'elles ne sont pas lues : une seule alerte « 4 tâches en
 * retard » plutôt que quatre. L'accusé de réception est obligatoire et l'historique conservé.
 */
const alerteSchema = new mongoose.Schema({
  type: { type: String, enum: Object.keys(ALERTES), required: true },
  /** « reco » (un RECO), « supervision » (superviseurs d'une structure), « structure » (structure d'orientation). */
  destinataire: { type: String, enum: ['reco', 'supervision', 'structure'], required: true },
  recoId: { type: mongoose.Schema.Types.ObjectId, ref: 'Reco', default: null, index: true },
  etablissementId: { type: String, default: null, index: true },
  /** Numéros des tâches concernées (REL-…). */
  taches: { type: [String], default: [] },
  occurrences: { type: Number, default: 1 },
  premiereLe: { type: Date, required: true },
  derniereLe: { type: Date, required: true },
  /** Alerte ouverte tant qu'elle n'a pas reçu d'accusé de réception. */
  ouverte: { type: Boolean, default: true },
  accuseLe: { type: Date, default: null },
  accusePar: { type: auteurSchema, default: undefined },
}, { toJSON: { transform: versJson }, versionKey: false });

// Regroupement : au plus une alerte ouverte par type et destinataire.
alerteSchema.index(
  { type: 1, destinataire: 1, recoId: 1, etablissementId: 1 },
  { unique: true, partialFilterExpression: { ouverte: true } },
);

module.exports = mongoose.model('AlerteRelance', alerteSchema, 'relance_alertes');
