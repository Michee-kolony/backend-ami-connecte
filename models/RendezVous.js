const mongoose = require('mongoose');
const { auteurSchema, versJson } = require('./commun');

const STATUTS_RDV = ['Planifié', 'Confirmé', 'Reporté', 'Effectué', 'Annulé', 'Absent'];
/** Statuts d'un rendez-vous encore attendu (pris en compte pour les doublons et l'agenda). */
const STATUTS_ACTIFS = ['Planifié', 'Confirmé', 'Reporté'];
const CANAUX_RAPPEL = ['SMS', 'Appel', 'WhatsApp', 'Aucun'];

/** Chaque report, annulation ou changement d'état est conservé avec son auteur et son motif. */
const evenementSchema = new mongoose.Schema({
  action: { type: String, required: true },
  ancienneDate: { type: Date, default: null },
  nouvelleDate: { type: Date, default: null },
  ancienStatut: { type: String, default: null },
  nouveauStatut: { type: String, default: null },
  motif: { type: String, default: '', trim: true },
  par: { type: auteurSchema, required: true },
  le: { type: Date, required: true },
}, { _id: false });

const rendezVousSchema = new mongoose.Schema({
  patienteId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patiente', required: true, index: true },
  grossesseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Grossesse', default: null },
  /** Rendez-vous de l'enfant (vaccination, suivi) : affiché dans l'espace de sa mère. */
  enfantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Enfant', default: null, index: true },
  /** Consultation qui a recommandé ce rendez-vous (facultatif). */
  consultationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Consultation', default: null },
  date: { type: Date, required: true, index: true },
  motif: { type: String, required: true, trim: true },
  etablissementId: { type: String, default: null },
  lieu: { type: String, default: '', trim: true },
  /** Consignes publiables à la patiente (pas de détail clinique sensible). */
  consignes: { type: String, default: '', trim: true },
  canalRappel: { type: String, enum: CANAUX_RAPPEL, default: 'Aucun' },
  statut: { type: String, enum: STATUTS_RDV, default: 'Planifié' },
  creePar: { type: auteurSchema, required: true },
  modifiePar: { type: auteurSchema, default: undefined },
  historique: { type: [evenementSchema], default: [] },
}, { timestamps: true, toJSON: { transform: versJson } });

module.exports = mongoose.model('RendezVous', rendezVousSchema, 'rendezvous');
module.exports.STATUTS_RDV = STATUTS_RDV;
module.exports.STATUTS_ACTIFS = STATUTS_ACTIFS;
module.exports.CANAUX_RAPPEL = CANAUX_RAPPEL;
