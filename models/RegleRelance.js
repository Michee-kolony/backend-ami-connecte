const mongoose = require('mongoose');
const { auteurSchema, versJson, dateJour } = require('./commun');
const { DOMAINES, PRIORITES, STATUTS_REGLE } = require('../config/relance');

const texte = { type: String, default: '', trim: true };

const parametresSchema = new mongoose.Schema({
  toleranceJours: { type: Number, min: 0, max: 365, required: true },
  fenetreJours: { type: Number, min: 1, max: 1830, required: true },
  delaiTraitementJours: { type: Number, min: 1, max: 90, required: true },
  priorite: { type: String, enum: PRIORITES, required: true },
  tentativesMax: { type: Number, min: 1, max: 10, required: true },
  alerteAvantEcheanceJours: { type: Number, min: 0, max: 30, required: true },
  priseEnChargeHeures: { type: Number, min: 1, max: 168, required: true },
  confirmationOrientationJours: { type: Number, min: 1, max: 60, required: true },
}, { _id: false });

const contenu = {
  libelle: { type: String, required: true, trim: true },
  description: texte,
  /** Parcours (RAC, ARC…) dans lequel les tâches de cette règle sont comptées. */
  parcoursCode: { type: String, default: null },
  parametres: { type: parametresSchema, required: true },
  version: { type: Number, required: true },
  dateEffet: dateJour(),
  statut: { type: String, enum: STATUTS_REGLE, default: 'Inactive' },
  /** Validation avant activation : responsable et protocole RDC/PEV de référence. */
  responsableValidation: texte,
  referenceProtocole: texte,
  modifiePar: { type: auteurSchema, required: true },
  modifieLe: { type: Date, required: true },
};

/**
 * Déclencheur de relance (section 4) : paramétrable et versionné. Le moteur n'applique que les
 * règles actives, validées, en vigueur et rattachées à un parcours validé.
 */
const regleSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true },
  domaine: { type: String, enum: DOMAINES, required: true },
  ...contenu,
  historique: { type: [new mongoose.Schema(contenu, { _id: false })], default: [] },
}, { timestamps: true, toJSON: { transform: versJson } });

module.exports = mongoose.model('RegleRelance', regleSchema, 'relance_regles');
module.exports.CHAMPS_CONTENU = Object.keys(contenu);
