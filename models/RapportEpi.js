const mongoose = require('mongoose');
const { auteurSchema, versJson } = require('./commun');
const { STATUTS_RAPPORT } = require('../config/epidemiologie');

const sansId = { _id: false };

/**
 * Sous-fenêtre 9 — rapport généré. Le contenu (tableaux, définitions, méthodes, limites) et les
 * versions des paramètres utilisés sont figés à la génération : une modification ultérieure des
 * données sources ne modifie jamais silencieusement un rapport publié ; il faut le régénérer
 * (nouvelle version, l'ancienne passe « Remplacé » et reste consultable).
 */
const rapportSchema = new mongoose.Schema({
  numero: { type: String, required: true, unique: true },
  type: { type: String, required: true, index: true },
  titre: { type: String, required: true, trim: true },
  parametres: {
    type: new mongoose.Schema({
      du: String, au: String, entiteCode: String, territoire: String, niveau: String, indicateurs: [String], desagregation: [String],
      inclureNonValidees: Boolean, periodicite: String,
    }, sansId),
    required: true,
  },
  contenu: {
    sections: [new mongoose.Schema({
      titre: String, colonnes: [String], lignes: [[mongoose.Schema.Types.Mixed]], notes: [String],
    }, sansId)],
    definitions: [new mongoose.Schema({ code: String, libelle: String, formule: String }, sansId)],
    limites: [String],
  },
  /** Versions des paramètres et calculs utilisés (traçabilité, reproductibilité). */
  versions: { type: mongoose.Schema.Types.Mixed, default: {} },
  sourceDonnees: { type: String, default: '' },
  statutDonnees: { type: String, default: 'Validées uniquement' },
  commentaire: { type: String, default: '', trim: true },
  statut: { type: String, enum: STATUTS_RAPPORT, default: 'Disponible' },
  version: { type: Number, default: 1 },
  remplacePar: { type: String, default: null },
  regenereDe: { type: String, default: null },
  validation: { type: new mongoose.Schema({ responsable: String, fonction: String, par: auteurSchema, le: Date }, sansId), default: undefined },
  generePar: { type: auteurSchema, required: true },
  exports: { type: [new mongoose.Schema({ format: String, par: auteurSchema, le: Date }, sansId)], default: [] },
}, { timestamps: true, toJSON: { transform: versJson } });

module.exports = mongoose.model('RapportEpi', rapportSchema, 'epi_rapports');
