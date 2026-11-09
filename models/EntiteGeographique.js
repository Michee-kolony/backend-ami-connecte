const mongoose = require('mongoose');
const { auteurSchema, versJson } = require('./commun');
const { NIVEAUX } = require('../config/epidemiologie');

/**
 * Référentiel géographique commun aux dix sous-fenêtres du module Épidémiologie (Partie I §1) :
 * pays, province, ville/territoire, zone de santé, aire de santé, formation sanitaire, communauté.
 * Chaque entité a un code unique ; `codeOfficiel` reprend le code du référentiel national quand il
 * existe. `chemin` liste les codes des ancêtres et de l'entité (filtre « dans ce territoire »).
 */
const entiteSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, trim: true, uppercase: true },
  codeOfficiel: { type: String, default: '', trim: true },
  niveau: { type: String, enum: NIVEAUX, required: true, index: true },
  nom: { type: String, required: true, trim: true },
  parentCode: { type: String, default: null },
  chemin: { type: [String], default: [], index: true },
  /** Formation sanitaire : établissement AMI correspondant (réalisations des modules AMI). */
  etablissementId: { type: String, default: null, index: true },
  actif: { type: Boolean, default: true },
  creePar: { type: auteurSchema, default: undefined },
}, { timestamps: true, toJSON: { transform: versJson } });

/** Identifiant lisible d'un nom (sans accents, majuscules, 24 caractères). */
entiteSchema.statics.segment = (texte) => String(texte || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'X';

module.exports = mongoose.model('EntiteGeographique', entiteSchema, 'epi_entites');
