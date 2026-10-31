const mongoose = require('mongoose');
const { auteurSchema, dateJour, versJson } = require('./commun');
const { STATUTS_AMBULANCE, TYPES_AMBULANCE } = require('../config/urgences');

/** Dernière position GPS connue, envoyée par l'application chauffeur. */
const positionSchema = new mongoose.Schema({
  lat: { type: Number, required: true, min: -90, max: 90 },
  lng: { type: Number, required: true, min: -180, max: 180 },
  /** Direction (degrés, 0 = nord) et vitesse (km/h), si le téléphone les donne. */
  cap: { type: Number, default: null },
  vitesse: { type: Number, default: null },
  precision: { type: Number, default: null },
  le: { type: Date, required: true },
}, { _id: false });

/**
 * Ambulance de la flotte. Identifiant public : le code (AMB-01). « En mission » (affichée
 * « Occupée ») tant qu'une urgence lui est confiée ; elle redevient disponible à la clôture.
 */
const ambulanceSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true },
  immatriculation: { type: String, required: true, unique: true, trim: true, uppercase: true },
  modele: { type: String, required: true, trim: true },
  annee: { type: Number, min: 1980, max: 2100, default: null },
  type: { type: String, enum: TYPES_AMBULANCE, required: true },
  /** Établissement propriétaire : seul son personnel voit, gère et envoie cette ambulance. */
  etablissementId: { type: String, default: null, index: true },
  statut: { type: String, enum: STATUTS_AMBULANCE, default: 'Disponible', index: true },
  /** Chauffeur attitré (et conducteur pendant la mission en cours). */
  chauffeurId: { type: mongoose.Schema.Types.ObjectId, ref: 'Chauffeur', default: null, index: true },
  /** Infirmier ou secouriste embarqué. */
  infirmier: { type: String, default: '', trim: true },
  kilometrage: { type: Number, min: 0, default: 0 },
  /** Niveau de carburant (%). */
  carburant: { type: Number, min: 0, max: 100, default: 100 },
  prochaineRevision: dateJour(),
  /** Urgence en cours (numéro URG-…) ; null hors mission. */
  urgence: { type: String, default: null },
  position: { type: positionSchema, default: undefined },
  creePar: { type: auteurSchema, required: true },
}, { timestamps: true, toJSON: { transform: versJson } });

/** AMB-01, AMB-02… */
ambulanceSchema.statics.prochainCode = async function () {
  const codes = await this.find({ code: /^AMB-\d+$/ }).select('code').lean();
  const n = codes.reduce((m, a) => Math.max(m, parseInt(a.code.slice(4), 10) || 0), 0);
  return `AMB-${String(n + 1).padStart(2, '0')}`;
};

module.exports = mongoose.model('Ambulance', ambulanceSchema);
