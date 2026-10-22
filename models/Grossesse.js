const mongoose = require('mongoose');
const { auteurSchema, versJson, dateJour } = require('./commun');

const JOUR = 86400000;
const METHODES_DATATION = ['DDR', 'Échographie', 'Examen clinique'];
const FIABILITES_DDR = ['Fiable', 'Incertaine', 'Inconnue'];
const ISSUES = ['Naissance vivante', 'Mort-né', 'Fausse couche', 'Interruption de grossesse', 'Grossesse extra-utérine', 'Autre'];
const MODES_ACCOUCHEMENT = ['Voie basse', 'Voie basse instrumentale', 'Césarienne', 'Non applicable'];

/**
 * Datation : l'âge gestationnel est connu à une date de référence (la DDR elle-même, ou le jour
 * de l'échographie / de l'examen). Elle est validée par un professionnel et n'est jamais inventée.
 */
const datationSchema = new mongoose.Schema({
  methode: { type: String, enum: METHODES_DATATION, required: true },
  ddr: dateJour(),
  ddrFiabilite: { type: String, enum: [...FIABILITES_DDR, null], default: null },
  /** Date à laquelle l'âge gestationnel de référence a été établi. */
  dateReference: dateJour(true),
  /** Âge gestationnel (en jours) à la date de référence : 0 pour une datation par DDR. */
  agReferenceJours: { type: Number, min: 0, max: 44 * 7, required: true },
  /** DPA calculée (référence + 280 j − AG) et DPA retenue (différente si corrigée et justifiée). */
  dpaCalculee: dateJour(true),
  dpa: dateJour(true),
  justification: { type: String, default: '', trim: true },
  valideePar: { type: auteurSchema, required: true },
  valideeLe: { type: Date, required: true },
}, { _id: false });

const grossesseSchema = new mongoose.Schema({
  patienteId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patiente', required: true, index: true },
  /** 1re, 2e… grossesse suivie dans la plateforme pour cette patiente. */
  numero: { type: Number, required: true },
  statut: { type: String, enum: ['En cours', 'Terminée'], default: 'En cours' },
  /** null tant que ce n'est pas confirmé (jamais déduit automatiquement). */
  grossesseMultiple: { type: Boolean, default: null },
  /** Facteurs de risque relevés par un professionnel (aucun calcul automatique). */
  facteursRisque: { type: [String], default: [] },

  datation: { type: datationSchema, default: undefined },
  /** Valeurs remplacées : la source, la date et l'auteur restent consultables. */
  historiqueDatation: { type: [datationSchema], default: [] },

  issue: {
    type: new mongoose.Schema({
      date: dateJour(true),
      lieu: { type: String, default: '', trim: true },
      issue: { type: String, enum: ISSUES, required: true },
      mode: { type: String, enum: MODES_ACCOUCHEMENT, default: 'Non applicable' },
      complications: { type: String, default: '', trim: true },
      resume: { type: String, default: '', trim: true },
      orientation: { type: String, default: '', trim: true },
      enregistreePar: { type: auteurSchema, required: true },
      enregistreeLe: { type: Date, required: true },
    }, { _id: false }),
    default: undefined,
  },

  creePar: { type: auteurSchema, required: true },
}, { timestamps: true, toJSON: { transform: versJson } });

grossesseSchema.index({ patienteId: 1, numero: 1 }, { unique: true });

/**
 * Règle de Naegele : DDR + 7 jours, puis + 9 mois (pour une DDR d'avril à décembre, cela revient
 * à − 3 mois et + 1 an). Un jour inexistant (ex. 31 février) est ramené au dernier jour du mois.
 */
function dpaNaegele(ddr) {
  const d = new Date(`${ddr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 7);
  const jourDuMois = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + 9);
  const dernierJour = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(jourDuMois, dernierJour));
  return d.toISOString().slice(0, 10);
}

/** Calcule la datation à partir de la saisie (DDR, ou âge gestationnel à une date). */
function calculerDatation({ methode, ddr, ddrFiabilite, dateReference, agSemaines, agJours, dpa, justification }) {
  const jour = (iso) => Date.parse(`${iso}T00:00:00Z`);
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  let reference;
  let agReferenceJours;
  if (methode === 'DDR') {
    if (!ddr) throw Object.assign(new Error('La DDR est requise pour une datation par DDR.'), { status: 400 });
    reference = ddr;
    agReferenceJours = 0;
  } else {
    if (!dateReference || agSemaines == null) {
      throw Object.assign(new Error('Date de l’examen et âge gestationnel requis.'), { status: 400 });
    }
    reference = dateReference;
    agReferenceJours = Number(agSemaines) * 7 + Number(agJours || 0);
  }
  if (!Number.isFinite(agReferenceJours) || agReferenceJours < 0 || agReferenceJours > 44 * 7) {
    throw Object.assign(new Error('Âge gestationnel hors plage (0 à 44 SA).'), { status: 400 });
  }
  if (Number.isNaN(jour(reference))) throw Object.assign(new Error('Date de référence invalide.'), { status: 400 });
  // DDR : règle de Naegele ; échographie ou examen clinique : référence + 280 j − AG.
  const dpaCalculee = methode === 'DDR' ? dpaNaegele(ddr) : iso(jour(reference) + (280 - agReferenceJours) * JOUR);
  const retenue = dpa || dpaCalculee;
  const ecart = Math.abs((jour(retenue) - jour(dpaCalculee)) / JOUR);
  if (ecart > 7 && !String(justification || '').trim()) {
    throw Object.assign(new Error('Justifiez la DPA retenue : elle s’écarte de plus de 7 jours de la DPA calculée.'), { status: 400 });
  }
  return {
    methode,
    ddr: methode === 'DDR' ? ddr : ddr || null,
    ddrFiabilite: ddr ? ddrFiabilite || 'Fiable' : null,
    dateReference: reference,
    agReferenceJours,
    dpaCalculee,
    dpa: retenue,
    justification: String(justification || '').trim(),
  };
}

/** Âge gestationnel (jours) à une date donnée, ou null si la grossesse n'est pas datée. */
grossesseSchema.methods.agJoursLe = function (date = new Date()) {
  if (!this.datation) return null;
  const ref = Date.parse(`${this.datation.dateReference}T00:00:00Z`);
  const jourCible = Date.parse(new Date(date).toISOString().slice(0, 10) + 'T00:00:00Z');
  return this.datation.agReferenceJours + Math.round((jourCible - ref) / JOUR);
};

module.exports = mongoose.model('Grossesse', grossesseSchema);
module.exports.calculerDatation = calculerDatation;
module.exports.dpaNaegele = dpaNaegele;
module.exports.METHODES_DATATION = METHODES_DATATION;
module.exports.ISSUES = ISSUES;
module.exports.MODES_ACCOUCHEMENT = MODES_ACCOUCHEMENT;
