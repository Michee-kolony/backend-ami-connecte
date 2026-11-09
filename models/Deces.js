const mongoose = require('mongoose');
const { versJson, dateJour } = require('./commun');
const { validationEpi } = require('./validationEpi');
const { LIEUX_DECES, OUI_NON_ND, SOURCES_DECES, SEXES } = require('../config/epidemiologie');

/**
 * Sous-fenêtre 6, formulaire B — décès. Les décès maternels, néonatals et infantiles suivent les
 * définitions et procédures nationales de classification et d'audit : la saisie ne certifie pas la
 * cause ; seuls les décès validés entrent dans les indicateurs.
 */
const decesSchema = new mongoose.Schema({
  numero: { type: String, required: true, unique: true },
  personne: {
    type: new mongoose.Schema({ type: { type: String, enum: ['Patiente', 'Enfant'] }, id: String, numero: String }, { _id: false }),
    default: undefined,
  },
  dateDeces: dateJour(true),
  ageAnnees: { type: Number, min: 0, max: 130, default: null },
  /** Âge en jours (décès néonatal : moins de 28 jours). */
  ageJours: { type: Number, min: 0, max: 400, default: null },
  sexe: { type: String, enum: SEXES, required: true },
  lieu: { type: String, enum: LIEUX_DECES, required: true },
  entiteCode: { type: String, required: true, index: true },
  etablissementId: { type: String, default: null },
  causeInitiale: { type: String, required: true },
  causesAssociees: { type: [String], default: [] },
  maternel: { type: String, enum: OUI_NON_ND, default: 'Non déterminé' },
  neonatal: { type: String, enum: OUI_NON_ND, default: 'Non déterminé' },
  infantile: { type: String, enum: OUI_NON_ND, default: 'Non déterminé' },
  source: { type: String, enum: SOURCES_DECES, required: true },
  /** Dossier AMI d'où vient le signalement (accouchement, enfant), le cas échéant. */
  origineAmi: { type: String, default: '' },
}, { timestamps: true, toJSON: { transform: versJson } });

decesSchema.plugin(validationEpi, { champs: ['dateDeces', 'causeInitiale', 'causesAssociees', 'maternel', 'neonatal', 'infantile', 'lieu', 'source'] });

module.exports = mongoose.model('Deces', decesSchema, 'epi_deces');
