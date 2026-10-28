const mongoose = require('mongoose');
const { auteurSchema, versJson, dateJour } = require('./commun');
const { STATUTS_PARCOURS } = require('../config/relance');

const texte = { type: String, default: '', trim: true };

/** Contenu versionné d'une fiche de parcours (une version = un état validé ou proposé). */
const contenu = {
  libelle: texte,
  /** Définition validée par le projet (jamais déduite par l'application). */
  definition: texte,
  criteresEntree: texte,
  actionsAutorisees: { type: [String], default: [] },
  /** Délai de traitement du parcours (jours), indicatif. */
  delaiJours: { type: Number, min: 1, max: 365, default: null },
  criteresSortie: texte,
  /** Formule de l'indicateur officiel (numérateur, dénominateur, période, population). */
  formuleIndicateur: texte,
  version: { type: Number, required: true },
  dateEffet: dateJour(),
  /** Responsable de la validation (nom et fonction) et référence du document validé. */
  responsableValidation: texte,
  referenceValidation: texte,
  statut: { type: String, enum: STATUTS_PARCOURS, default: 'À valider' },
  modifiePar: { type: auteurSchema, required: true },
  modifieLe: { type: Date, required: true },
};

/**
 * Fiche de paramétrage d'un parcours (RAC, ARC, RPC, IRC, TCC — section 7). Les cinq parcours
 * partagent le même moteur de tâches mais restent distincts dans les rapports. Chaque
 * modification crée une nouvelle version ; les versions précédentes restent consultables et
 * chaque tâche garde la version en vigueur à sa création.
 */
const parcoursSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, uppercase: true, trim: true, match: /^[A-Z0-9_-]{2,12}$/ },
  ...contenu,
  historique: { type: [new mongoose.Schema(contenu, { _id: false })], default: [] },
}, { timestamps: true, toJSON: { transform: versJson } });

/** Un parcours est utilisable par le moteur seulement s'il est validé et en vigueur. */
parcoursSchema.methods.enVigueur = function (jour) {
  return this.statut === 'Validé' && (!this.dateEffet || this.dateEffet <= jour);
};

module.exports = mongoose.model('ParcoursRelance', parcoursSchema, 'relance_parcours');
module.exports.CHAMPS_CONTENU = Object.keys(contenu);
