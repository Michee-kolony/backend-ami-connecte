const mongoose = require('mongoose');
const { auteurSchema, versJson, dateJour } = require('./commun');
const acc = require('../config/accouchement');
const vaccination = require('../config/vaccination');

const ouiNon = { type: Boolean, default: null };
const texte = { type: String, default: '', trim: true };
const nombre = (min, max) => ({ type: Number, min, max, default: null });
const sansId = { _id: false };

const STATUTS_ENFANT = ['Suivi', 'Décédé', 'Transféré'];
/** Né dans la plateforme (dossier d'accouchement), ou ailleurs puis enregistré pour sa vaccination. */
const ORIGINES = ['Né dans la plateforme', 'Né hors plateforme'];
const ALIMENTATIONS = ['Allaitement exclusif', 'Allaitement mixte', 'Alimentation de complément', 'Alimentation familiale'];

/** Cotation APGAR à une minute donnée : 5 critères de 0 à 2, total calculé. */
const apgarSchema = new mongoose.Schema({
  ...Object.fromEntries(acc.APGAR_CRITERES.map(({ code }) => [code, nombre(0, 2)])),
  total: nombre(0, 10),
}, sansId);

/** Module 5 — Naissance : SENN, cordon, allaitement, mensurations, APGAR, réanimation, traitement. */
const naissanceSchema = new mongoose.Schema({
  /** Soins essentiels du nouveau-né. */
  senn: { maintienTemperature: ouiNon, temperatureAxillaire: nombre(30, 45), crede: ouiNon },
  soinsCordon: { lameSterile: ouiNon, filSterile: ouiNon },
  miseAuSeinMoins1h: ouiNon,
  poidsG: nombre(300, 7000),
  tailleCm: nombre(20, 70),
  perimetreCranienCm: nombre(15, 50),
  malformations: { presentes: ouiNon, description: texte },
  apgar: {
    m1: { type: apgarSchema, default: () => ({}) },
    m5: { type: apgarSchema, default: () => ({}) },
    m10: { type: apgarSchema, default: () => ({}) },
  },
  reanimation: { faite: ouiNon, stimulation: ouiNon, aspiration: ouiNon, ventilation: ouiNon },
  traitement: {
    vitamineK1: ouiNon,
    antibiotique: ouiNon, antibiotiquePrecision: texte,
    arv: ouiNon, arvPrecision: texte,
  },
}, sansId);

/** Dose du calendrier administrée (vaccin, vitamine A, mébendazole) : jamais effacée, annulée avec motif si erronée. */
const administrationSchema = new mongoose.Schema({
  code: { type: String, enum: vaccination.CODES, required: true },
  date: dateJour(true),
  lot: texte,
  site: texte,
  lieu: texte,
  etablissementId: { type: String, default: null },
  observations: texte,
  /** Dose reçue ailleurs, recopiée du carnet papier à l'enregistrement (administreePar : qui l'a recopiée). */
  reportee: { type: Boolean, default: false },
  administreePar: { type: auteurSchema, required: true },
  le: { type: Date, required: true },
  annulation: {
    type: new mongoose.Schema({ motif: { type: String, required: true, trim: true }, par: auteurSchema, le: Date }, sansId),
    default: undefined,
  },
}, { toJSON: { transform: versJson } });

/** Visite de suivi de l'enfant (croissance, alimentation, développement). */
const suiviSchema = new mongoose.Schema({
  date: dateJour(true),
  poidsG: nombre(300, 40000),
  tailleCm: nombre(20, 150),
  perimetreCranienCm: nombre(15, 60),
  perimetreBrachialCm: nombre(5, 30),
  temperature: nombre(30, 45),
  alimentation: { type: String, enum: [...ALIMENTATIONS, ''], default: '' },
  developpement: texte,
  observations: texte,
  auteur: { type: auteurSchema, required: true },
  le: { type: Date, required: true },
}, { toJSON: { transform: versJson } });

/**
 * Dossier de l'enfant, de la naissance à l'âge préscolaire. Rattaché au compte de sa mère
 * (mereId) : la mère voit son carnet, ses vaccins et ses rendez-vous dans son espace.
 */
const enfantSchema = new mongoose.Schema({
  /** Identifiant public AC-ENF-000001. */
  numero: { type: String, required: true, unique: true },
  mereId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patiente', required: true, index: true },
  accouchementId: { type: mongoose.Schema.Types.ObjectId, ref: 'Accouchement', default: null, index: true },
  grossesseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Grossesse', default: null },
  etablissementId: { type: String, default: null },
  origine: { type: String, enum: ORIGINES, default: 'Né dans la plateforme' },
  /** Né hors plateforme : lieu de naissance déclaré (autre maternité, domicile…). */
  lieuNaissance: texte,

  nom: { type: String, default: '', trim: true, uppercase: true },
  postnom: { type: String, default: '', trim: true, uppercase: true },
  prenom: texte,
  sexe: { type: String, enum: acc.SEXES, required: true },
  /** Date et heure de naissance ; dateNaissance = jour civil à Kinshasa (base du calendrier vaccinal). */
  neLe: { type: Date, required: true },
  dateNaissance: dateJour(true),
  /** Rang de naissance (jumeaux : 1, 2…). */
  rang: { type: Number, min: 1, max: 6, default: 1 },
  etatNaissance: { type: String, enum: acc.ETATS_NAISSANCE, default: 'Vivant' },
  naissance: { type: naissanceSchema, default: () => ({}) },
  /** Photo d'identification prise à la naissance (évite les confusions entre bébés) : clé R2, servie par lien signé. */
  photoCle: { type: String, default: null },

  vaccinations: { type: [administrationSchema], default: [] },
  suivis: { type: [suiviSchema], default: [] },

  statut: { type: String, enum: STATUTS_ENFANT, default: 'Suivi' },
  /** Dernier rappel push de vaccination envoyé à la mère (AAAA-MM-JJ, voir config/rappels.js). */
  rappelVaccinJour: { type: String, default: null },
  creePar: { type: auteurSchema, required: true },
  modifiePar: { type: auteurSchema, default: undefined },
}, {
  timestamps: true,
  toJSON: {
    transform: (doc, ret) => {
      versJson(doc, ret);
      delete ret.photoCle;
      delete ret.rappelVaccinJour;
      return ret;
    },
  },
});

enfantSchema.index({ nom: 1, prenom: 1 });

/** Totaux APGAR recalculés à chaque enregistrement (jamais saisis). */
enfantSchema.pre('validate', function () {
  if (this.neLe && !Number.isNaN(this.neLe.getTime())) this.dateNaissance = vaccination.jourKinshasa(this.neLe);
  for (const m of ['m1', 'm5', 'm10']) {
    const a = this.naissance?.apgar?.[m];
    if (!a) continue;
    const notes = acc.APGAR_CRITERES.map(({ code }) => a[code]);
    a.total = notes.every((n) => n == null) ? null : notes.reduce((s, n) => s + (n ?? 0), 0);
  }
});

/** AC-ENF-000001, AC-ENF-000002… */
enfantSchema.statics.prochainNumero = async function () {
  const dernier = await this.findOne({ numero: /^AC-ENF-\d+$/ }).sort({ numero: -1 }).select('numero');
  const n = dernier ? parseInt(dernier.numero.slice(7), 10) || 0 : 0;
  return `AC-ENF-${String(n + 1).padStart(6, '0')}`;
};

/** L'enfant est suivi (vaccination, rendez-vous) : né vivant et ni décédé ni transféré. */
enfantSchema.methods.estSuivi = function () {
  return this.etatNaissance === 'Vivant' && this.statut === 'Suivi';
};

/** Carnet vaccinal calculé (null pour un mort-né). */
enfantSchema.methods.carnet = function (aujourdhui) {
  if (this.etatNaissance !== 'Vivant') return null;
  return vaccination.calendrier(this.dateNaissance, this.vaccinationsValides(), aujourdhui);
};

/** Doses administrées, hors saisies annulées. */
enfantSchema.methods.vaccinationsValides = function () {
  return this.vaccinations.filter((v) => !v.annulation);
};

/** Âge lisible : jours, puis semaines, puis mois révolus. */
enfantSchema.methods.age = function (aujourdhui = vaccination.jourKinshasa()) {
  const jours = Math.round((Date.parse(`${aujourdhui}T00:00:00Z`) - Date.parse(`${this.dateNaissance}T00:00:00Z`)) / 86400000);
  if (jours < 0) return null;
  const [a1, m1, j1] = this.dateNaissance.split('-').map(Number);
  const [a2, m2, j2] = aujourdhui.split('-').map(Number);
  const mois = (a2 - a1) * 12 + (m2 - m1) - (j2 < j1 ? 1 : 0);
  const libelle = jours < 28 ? `${jours} jour${jours > 1 ? 's' : ''}`
    : mois < 3 ? `${Math.floor(jours / 7)} semaines`
    : mois < 24 ? `${mois} mois`
    : `${Math.floor(mois / 12)} ans`;
  return { jours, mois, libelle };
};

module.exports = mongoose.model('Enfant', enfantSchema);
module.exports.STATUTS_ENFANT = STATUTS_ENFANT;
module.exports.ORIGINES = ORIGINES;
module.exports.ALIMENTATIONS = ALIMENTATIONS;
