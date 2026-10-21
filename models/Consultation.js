const mongoose = require('mongoose');
const { auteurSchema, versJson, dateJour } = require('./commun');

const TYPES_CONSULTATION = [
  'Première consultation prénatale', 'Suivi prénatal', 'Consultation non programmée', 'Accouchement', 'Postnatal',
];
const STATUTS_CONSULTATION = ['Brouillon', 'Finalisée', 'Annulée'];

const traitementSchema = new mongoose.Schema({
  produit: { type: String, required: true, trim: true },
  dose: { type: String, default: '', trim: true },
  voie: { type: String, default: '', trim: true },
  frequence: { type: String, default: '', trim: true },
  duree: { type: String, default: '', trim: true },
  indication: { type: String, default: '', trim: true },
}, { _id: false });

/** Correction d'une consultation finalisée : ajoutée, jamais substituée à la note initiale. */
const addendumSchema = new mongoose.Schema({
  texte: { type: String, required: true, trim: true },
  motif: { type: String, required: true, trim: true },
  auteur: { type: auteurSchema, required: true },
  le: { type: Date, required: true },
}, { toJSON: { transform: versJson } });

/** Champs cliniques modifiables tant que la consultation est un brouillon. */
const CHAMPS_CLINIQUES = [
  'type', 'date', 'motif', 'symptomes', 'constantes', 'examenClinique', 'evaluation', 'facteursRisque',
  'decisions', 'examensDemandes', 'resultatsRevus', 'traitements', 'conseils', 'orientation', 'prochainRdv',
];

/**
 * Une consultation est un événement distinct : son auteur est le médecin authentifié qui l'a
 * réalisée. Une fois finalisée, elle n'est plus modifiable : les corrections sont des addenda.
 */
const consultationSchema = new mongoose.Schema({
  patienteId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patiente', required: true, index: true },
  grossesseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Grossesse', required: true, index: true },
  type: { type: String, enum: TYPES_CONSULTATION, required: true },
  /** Date et heure réelles de la consultation (UTC en base). */
  date: { type: Date, required: true },
  etablissementId: { type: String, default: null },
  auteur: { type: auteurSchema, required: true },

  /** Âge gestationnel calculé à la date de consultation (jours), figé à la finalisation. */
  agJours: { type: Number, default: null },
  motif: { type: String, default: '', trim: true },
  symptomes: { type: String, default: '', trim: true },
  constantes: {
    poidsKg: { type: Number, min: 20, max: 250, default: null },
    taSystolique: { type: Number, min: 50, max: 260, default: null },
    taDiastolique: { type: Number, min: 30, max: 180, default: null },
    temperature: { type: Number, min: 30, max: 45, default: null },
    pouls: { type: Number, min: 30, max: 220, default: null },
    hauteurUterineCm: { type: Number, min: 0, max: 50, default: null },
    bcf: { type: Number, min: 50, max: 220, default: null },
  },
  examenClinique: { type: String, default: '', trim: true },
  evaluation: { type: String, default: '', trim: true },
  facteursRisque: { type: [String], default: [] },
  decisions: { type: String, default: '', trim: true },
  examensDemandes: { type: [String], default: [] },
  resultatsRevus: { type: String, default: '', trim: true },
  /** Prescriptions validées par le médecin (aucune prescription automatique). */
  traitements: { type: [traitementSchema], default: [] },
  conseils: { type: String, default: '', trim: true },
  orientation: { type: String, default: '', trim: true },
  /** Prochain rendez-vous recommandé : créé dans l'agenda à la finalisation. */
  prochainRdv: {
    date: { type: Date, default: null },
    motif: { type: String, default: '', trim: true },
    consignes: { type: String, default: '', trim: true },
  },
  prochainRdvId: { type: mongoose.Schema.Types.ObjectId, ref: 'RendezVous', default: null },
  /** Rendez-vous honoré par cette consultation (marqué « Effectué » à la finalisation). */
  rendezVousId: { type: mongoose.Schema.Types.ObjectId, ref: 'RendezVous', default: null },

  statut: { type: String, enum: STATUTS_CONSULTATION, default: 'Brouillon' },
  finaliseeLe: { type: Date, default: null },
  annulation: {
    type: new mongoose.Schema({ motif: { type: String, required: true }, par: auteurSchema, le: Date }, { _id: false }),
    default: undefined,
  },
  addenda: { type: [addendumSchema], default: [] },
}, { timestamps: true, toJSON: { transform: versJson } });

consultationSchema.index({ grossesseId: 1, date: 1 });

module.exports = mongoose.model('Consultation', consultationSchema);
module.exports.TYPES_CONSULTATION = TYPES_CONSULTATION;
module.exports.CHAMPS_CLINIQUES = CHAMPS_CLINIQUES;
