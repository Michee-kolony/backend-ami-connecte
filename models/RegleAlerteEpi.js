const mongoose = require('mongoose');
const { auteurSchema, versJson } = require('./commun');
const { DOMAINES_ALERTE, PRIORITES, STATUTS_REGLE, OPERATEURS } = require('../config/epidemiologie');

/**
 * Sous-fenêtre 8, formulaire A — configuration d'une alerte. Les seuils ne sont pas inventés par
 * les développeurs : une règle naît en brouillon, sans effet, et ne s'active qu'avec un seuil, un
 * responsable de validation et la référence du document qui le fixe. Chaque modification crée une
 * version (l'ancienne est gardée) et désactive la règle jusqu'à sa nouvelle validation.
 */
const regleSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true },
  nom: { type: String, required: true, trim: true },
  domaine: { type: String, enum: DOMAINES_ALERTE, required: true },
  /** Indicateur surveillé (config INDICATEURS_ALERTE) et son paramètre (code d'indicateur, maladie). */
  indicateur: { type: String, required: true },
  parametre: { type: String, default: '' },
  operateur: { type: String, enum: OPERATEURS, required: true },
  seuil: { type: Number, default: null },
  priorite: { type: String, enum: PRIORITES, required: true },
  /** Périmètre : entité géographique (toutes ses formations sanitaires) ; null = tout le référentiel. */
  entiteCode: { type: String, default: null },
  destinataire: { type: String, default: '', trim: true },
  delaiTraitementJours: { type: Number, min: 1, max: 365, default: 7 },
  message: { type: String, default: '', trim: true },
  actionRecommandee: { type: String, default: '', trim: true },
  statut: { type: String, enum: STATUTS_REGLE, default: 'Brouillon' },
  version: { type: Number, default: 1 },
  responsableValidation: { type: String, default: '' },
  referenceValidation: { type: String, default: '' },
  creePar: { type: auteurSchema, required: true },
  modifiePar: { type: auteurSchema, default: undefined },
  historique: { type: [mongoose.Schema.Types.Mixed], default: [] },
}, { timestamps: true, toJSON: { transform: versJson } });

regleSchema.statics.CHAMPS_CONTENU = ['nom', 'domaine', 'indicateur', 'parametre', 'operateur', 'seuil', 'priorite', 'entiteCode', 'destinataire',
  'delaiTraitementJours', 'message', 'actionRecommandee', 'statut', 'responsableValidation', 'referenceValidation'];

module.exports = mongoose.model('RegleAlerteEpi', regleSchema, 'epi_regles_alerte');
