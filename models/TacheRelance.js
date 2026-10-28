const mongoose = require('mongoose');
const { auteurSchema, versJson } = require('./commun');
const r = require('../config/relance');

const texte = { type: String, default: '', trim: true };
const sansId = { _id: false };
const { ObjectId } = mongoose.Schema.Types;

/** Motif de relance : une règle satisfaite pour un objet précis (rendez-vous, grossesse, dose…). */
const motifSchema = new mongoose.Schema({
  /** Clé unique du motif (règle + objet) : un même motif ne génère jamais deux relances. */
  cle: { type: String, required: true },
  regleCode: { type: String, default: null },
  regleVersion: { type: Number, default: null },
  libelle: { type: String, required: true },
  objet: {
    type: { type: String, default: null },
    id: { type: String, default: null },
    libelle: texte,
  },
  dateEvenement: { type: Date, default: null },
  ajouteLe: { type: Date, required: true },
}, sansId);

/** Action du RECO : chaque tentative, visite et orientation est conservée, jamais écrasée. */
const actionSchema = new mongoose.Schema({
  /** Identifiant unique attribué par l'appareil (hors connexion) : jamais traité deux fois. */
  operationId: { type: String, required: true },
  type: { type: String, enum: r.ACTIONS_RECO, required: true },
  canal: { type: String, enum: [...r.CANAUX, null], default: null },
  resultat: { type: String, default: null },
  motif: { type: String, default: null },
  commentaire: { type: String, default: '', trim: true, maxlength: r.COMMENTAIRE_MAX },
  /** Visite planifiée : date convenue ; orientation : date conseillée. */
  date: { type: Date, default: null },
  structure: { type: String, default: null },
  priorite: { type: String, enum: [...r.PRIORITES, null], default: null },
  /** Heure de l'action sur l'appareil, et heure de réception par le serveur. */
  le: { type: Date, required: true },
  recuLe: { type: Date, required: true },
  par: { type: auteurSchema, required: true },
  appareil: { type: String, default: null },
  horsLigne: { type: Boolean, default: false },
  /** Action reçue après une clôture ou une réattribution : conservée sans modifier la tâche. */
  conflit: { type: Boolean, default: false },
}, sansId);

const evenementSchema = new mongoose.Schema({
  action: { type: String, required: true },
  ancienStatut: { type: String, default: null },
  nouveauStatut: { type: String, default: null },
  motif: texte,
  details: { type: mongoose.Schema.Types.Mixed, default: undefined },
  par: { type: auteurSchema, required: true },
  le: { type: Date, required: true },
}, sansId);

const conflitSchema = new mongoose.Schema({
  operationId: { type: String, required: true },
  motif: { type: String, required: true },
  le: { type: Date, required: true },
  resolu: { type: Boolean, default: false },
  decision: texte,
  resoluPar: { type: auteurSchema, default: undefined },
  resoluLe: { type: Date, default: null },
}, { toJSON: { transform: versJson } });

/**
 * Tâche de relance communautaire (sections 5 et 8). Une personne n'a qu'une tâche active par
 * parcours : les autres motifs du même parcours sont reliés à cette tâche principale.
 */
const tacheSchema = new mongoose.Schema({
  /** Identifiant public REL-000001. */
  numero: { type: String, required: true, unique: true },
  parcoursCode: { type: String, default: null, index: true },
  parcoursVersion: { type: Number, default: null },
  domaine: { type: String, enum: r.DOMAINES, required: true, index: true },
  source: { type: String, enum: r.SOURCES, required: true },
  motifs: { type: [motifSchema], default: [] },
  clesMotifs: { type: [String], default: [], index: true },

  // Personne (identifiants minimaux, section 8)
  personneType: { type: String, enum: ['Patiente', 'Enfant', 'Déclarée'], required: true },
  patienteId: { type: ObjectId, ref: 'Patiente', default: null, index: true },
  enfantId: { type: ObjectId, ref: 'Enfant', default: null, index: true },
  grossesseId: { type: ObjectId, ref: 'Grossesse', default: null },
  /** Personne signalée par un RECO, pas encore identifiée dans AMI (vérification par le superviseur). */
  declaree: {
    type: new mongoose.Schema({ nom: texte, quartier: texte, repere: texte, telephone: texte }, sansId),
    default: undefined,
  },
  /** Clé de dédoublonnage : parcours + personne. */
  cle: { type: String, required: true },
  ouverte: { type: Boolean, default: true },

  // Affectation
  etablissementId: { type: String, default: null, index: true },
  aireSante: texte,
  zone: texte,
  recoId: { type: ObjectId, ref: 'Reco', default: null, index: true },
  superviseurId: { type: ObjectId, ref: 'Soignant', default: null },
  attribueeLe: { type: Date, default: null },
  reattributions: { type: Number, default: 0 },

  // Contexte
  priorite: { type: String, enum: r.PRIORITES, default: 'Normale' },
  /** Paramètres de la règle figés à la création (tentatives, délais d'alerte). */
  parametres: {
    tentativesMax: { type: Number, default: 3 },
    alerteAvantEcheanceJours: { type: Number, default: 1 },
    priseEnChargeHeures: { type: Number, default: 24 },
    confirmationOrientationJours: { type: Number, default: 7 },
  },
  dateEvenement: { type: Date, default: null },
  echeance: { type: Date, required: true, index: true },
  statut: { type: String, enum: r.STATUTS, default: 'Nouvelle', index: true },
  statutLe: { type: Date, default: Date.now },

  // Actions
  actions: { type: [actionSchema], default: [] },
  tentativesEchouees: { type: Number, default: 0 },
  contactEtabliLe: { type: Date, default: null },
  visites: {
    type: [new mongoose.Schema({
      prevueLe: { type: Date, required: true },
      planifieeLe: { type: Date, required: true },
      realiseeLe: { type: Date, default: null },
      resultat: { type: String, default: null },
    }, sansId)],
    default: [],
  },
  orientation: {
    type: new mongoose.Schema({
      le: { type: Date, required: true },
      etablissementId: { type: String, default: null },
      structure: texte,
      priorite: { type: String, enum: r.PRIORITES, default: 'Normale' },
      dateConseillee: { type: Date, default: null },
      par: { type: auteurSchema, required: true },
    }, sansId),
    default: undefined,
  },

  // Résolution
  confirmation: {
    type: new mongoose.Schema({
      le: { type: Date, required: true },
      /** « Dossier de soins » (prestation enregistrée par un soignant) ou « Structure » (confirmation manuelle). */
      source: { type: String, enum: ['Dossier de soins', 'Structure'], required: true },
      type: texte,
      reference: { type: String, required: true, trim: true },
      /** Personne revenue avant tout contact du RECO. */
      avantContact: { type: Boolean, default: false },
      par: { type: auteurSchema, required: true },
    }, sansId),
    default: undefined,
  },
  resolution: {
    type: new mongoose.Schema({
      statut: { type: String, enum: r.STATUTS_FINAUX, required: true },
      resultat: { type: String, enum: r.RESULTATS_CLOTURE, required: true },
      motif: texte,
      exceptionnelle: { type: Boolean, default: false },
      le: { type: Date, required: true },
      par: { type: auteurSchema, required: true },
    }, sansId),
    default: undefined,
  },
  /** Doublon annulé : numéro de la tâche conservée. */
  doublonDe: { type: String, default: null },
  escalade: {
    type: new mongoose.Schema({ le: Date, motif: texte, vers: texte, par: auteurSchema }, sansId),
    default: undefined,
  },
  controles: {
    type: [new mongoose.Schema({ le: Date, conforme: Boolean, observation: texte, par: auteurSchema }, sansId)],
    default: [],
  },
  conflits: { type: [conflitSchema], default: [] },
  /** Alertes déjà émises pour cette tâche (une seule fois chacune). */
  alertes: {
    echeanceProche: { type: Date, default: null },
    retard: { type: Date, default: null },
    urgenteNonPrise: { type: Date, default: null },
    orientationNonConfirmee: { type: Date, default: null },
    nonAttribuee: { type: Date, default: null },
  },

  historique: { type: [evenementSchema], default: [] },
  creePar: { type: auteurSchema, required: true },
}, { timestamps: true, toJSON: { transform: versJson } });

// Une seule tâche active par parcours et par personne (critère d'acceptation n° 1).
tacheSchema.index({ cle: 1 }, { unique: true, partialFilterExpression: { ouverte: true } });
tacheSchema.index({ etablissementId: 1, statut: 1 });
tacheSchema.index({ createdAt: 1 });

tacheSchema.pre('validate', function () {
  this.ouverte = !r.STATUTS_FINAUX.includes(this.statut);
});

/** REL-000001, REL-000002… */
tacheSchema.statics.prochainNumero = async function () {
  const dernier = await this.findOne({ numero: /^REL-\d+$/ }).sort({ numero: -1 }).select('numero');
  const n = dernier ? parseInt(dernier.numero.slice(4), 10) || 0 : 0;
  return `REL-${String(n + 1).padStart(6, '0')}`;
};

/** Change le statut et l'inscrit dans l'historique (chaque changement est journalisé). */
tacheSchema.methods.changerStatut = function (statut, par, { action, motif = '', details, le = new Date() } = {}) {
  const ancien = this.statut;
  this.historique.push({ action: action ?? statut, ancienStatut: ancien, nouveauStatut: statut, motif, details, par, le });
  if (ancien !== statut) {
    this.statut = statut;
    this.statutLe = le;
  }
};

/** Événement de l'historique sans changement de statut. */
tacheSchema.methods.noter = function (action, par, { motif = '', details, le = new Date() } = {}) {
  this.historique.push({ action, ancienStatut: this.statut, nouveauStatut: this.statut, motif, details, par, le });
};

tacheSchema.methods.estOuverte = function () {
  return !r.STATUTS_FINAUX.includes(this.statut);
};

/** Échéance dépassée sur une tâche encore ouverte. */
tacheSchema.methods.enRetard = function (maintenant = new Date()) {
  return this.estOuverte() && this.echeance < maintenant;
};

module.exports = mongoose.model('TacheRelance', tacheSchema, 'relance_taches');
