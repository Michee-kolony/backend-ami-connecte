const mongoose = require('mongoose');
const { auteurSchema, versJson } = require('./commun');
const u = require('../config/urgences');

/** Étape horodatée de la chronologie d'une urgence (jamais modifiée ni supprimée). */
const evenementSchema = new mongoose.Schema({
  le: { type: Date, required: true },
  type: { type: String, enum: u.TYPES_EVENEMENT, required: true },
  /** Nom affiché : « Application patiente », un soignant ou le chauffeur. */
  auteur: { type: String, required: true },
  detail: { type: String, default: '' },
}, { _id: false });

/**
 * Alerte de détresse déclenchée par une patiente depuis l'application mobile, puis prise en
 * charge par la régulation (personnel soignant) qui envoie un chauffeur et une ambulance.
 */
const urgenceSchema = new mongoose.Schema({
  /** Identifiant public URG-000001. */
  numero: { type: String, required: true, unique: true },
  patienteId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patiente', required: true, index: true },
  motif: { type: String, enum: u.MOTIFS.map((m) => m.code), required: true },
  precisions: { type: String, default: '', trim: true },
  gravite: { type: String, enum: u.GRAVITES, required: true },
  etat: { type: String, enum: u.ETATS, default: 'nouvelle', index: true },
  /** Position de la patiente au déclenchement (mise à jour si elle se déplace). */
  lat: { type: Number, required: true, min: -90, max: 90 },
  lng: { type: Number, required: true, min: -180, max: 180 },
  precisionM: { type: Number, default: null },
  /** Téléphone de la patiente au moment de l'alerte (rappel par la régulation). */
  telephone: { type: String, default: '' },
  etablissementId: { type: String, default: null },

  prisEnChargePar: { type: auteurSchema, default: undefined },
  /** Course : ambulance (code) et chauffeur engagés, conservés après la mission pour l'historique. */
  ambulance: { type: String, default: null, index: true },
  chauffeurId: { type: mongoose.Schema.Types.ObjectId, ref: 'Chauffeur', default: null, index: true },
  chauffeurNom: { type: String, default: '' },
  statutCourse: { type: String, enum: [...u.STATUTS_COURSE, null], default: null },

  evenements: { type: [evenementSchema], default: [] },
  clotureLe: { type: Date, default: null },
}, { timestamps: true, toJSON: { transform: versJson } });

urgenceSchema.index({ etat: 1, createdAt: -1 });

/** URG-000001, URG-000002… (l'index unique protège des collisions). */
urgenceSchema.statics.prochainNumero = async function () {
  const dernier = await this.findOne({ numero: /^URG-\d+$/ }).sort({ numero: -1 }).select('numero');
  const n = dernier ? parseInt(dernier.numero.slice(4), 10) || 0 : 0;
  return `URG-${String(n + 1).padStart(6, '0')}`;
};

urgenceSchema.methods.journaliser = function (type, auteur, detail = '') {
  this.evenements.push({ le: new Date(), type, auteur, detail });
};

urgenceSchema.methods.estActive = function () {
  return u.ETATS_ACTIFS.includes(this.etat);
};

module.exports = mongoose.model('Urgence', urgenceSchema);
