const mongoose = require('mongoose');
const { auteurSchema, versJson, dateJour } = require('./commun');
const { PROVINCES_RDC } = require('../config/referentiels');
const cpn = require('../config/cpn');

/** Liste de valeurs d'un référentiel (cases à cocher de la fiche CPN). */
const cases = (valeurs) => ({ type: [{ type: String, enum: valeurs }], default: [] });
/** Choix facultatif dans un référentiel ('' = non renseigné). */
const choix = (valeurs) => ({ type: String, enum: [...valeurs, ''], default: '' });

const STATUTS_PATIENTE = ['Suivi prénatal', 'Grossesse terminée', 'Suivi postnatal', 'Archivé'];
const CANAUX = ['sms', 'appel', 'whatsapp'];

/** Le dossier appartient à la patiente : aucun médecin n'en est « propriétaire ». */
const patienteSchema = new mongoose.Schema({
  /** Identifiant public interne AC-PAT-000001, distinct de l'identifiant MongoDB. */
  numero: { type: String, required: true, unique: true },

  // Identité
  nom: { type: String, required: true, trim: true, uppercase: true },
  postnom: { type: String, default: '', trim: true, uppercase: true },
  prenom: { type: String, default: '', trim: true },
  /** Date de naissance si connue, sinon âge déclaré (année de naissance estimée). */
  dateNaissance: dateJour(),
  ageDeclare: { type: Number, min: 8, max: 70, default: null },
  ageDeclareLe: dateJour(),
  pieceIdentite: { type: String, default: '', trim: true },
  etatCivil: choix(cpn.ETATS_CIVILS),
  occupation: { type: String, default: '', trim: true },
  nomPartenaire: { type: String, default: '', trim: true },

  // Profil biologique (fiche CPN)
  groupeSanguin: choix(cpn.GROUPES_SANGUINS),
  rhesus: choix(cpn.RHESUS),
  tailleCm: { type: Number, min: 100, max: 220, default: null },
  electrophoreseHb: choix(cpn.ELECTROPHORESES),

  // Contact
  telephone: { type: String, default: '', trim: true },
  telephonePartage: { type: Boolean, default: false },
  telephone2: { type: String, default: '', trim: true },
  /** Chiffres seuls des numéros (recherche et doublons, quel que soit le format saisi). */
  telephoneChiffres: { type: String, default: '', index: true },
  telephone2Chiffres: { type: String, default: '' },
  /** Facultatif : servira à activer l'espace patiente (application mobile, plus tard). */
  /** Identifiant de connexion de l'espace patiente (application mobile). */
  email: {
    type: String, trim: true, lowercase: true, unique: true, sparse: true,
    set: (v) => (v && String(v).trim() ? v : undefined),
  },
  /** Mot de passe choisi par la patiente à l'enregistrement, haché (bcrypt) ; jamais renvoyé. */
  motDePasse: { type: String, select: false },
  /** Photo d'identification : clé d'objet R2, servie uniquement par lien signé temporaire. */
  photoCle: { type: String, default: null },
  contactUrgence: {
    nom: { type: String, default: '', trim: true },
    lien: { type: String, default: '', trim: true },
    telephone: { type: String, default: '', trim: true },
  },
  /** Consentement par canal : true, false ou null (non recueilli). */
  consentements: {
    sms: { type: Boolean, default: null },
    appel: { type: Boolean, default: null },
    whatsapp: { type: Boolean, default: null },
    version: { type: String, default: 'v1.2' },
    recueilliLe: { type: Date, default: null },
    recueilliPar: { type: auteurSchema, default: undefined },
  },

  // Résidence
  adresse: {
    /** Une des 26 provinces (exigée à l'enregistrement ; vide seulement pour un dossier ancien). */
    province: {
      type: String, default: '', trim: true,
      enum: { values: [...PROVINCES_RDC, ''], message: 'Province inconnue : choisissez une des 26 provinces de la RDC.' },
    },
    commune: { type: String, default: '', trim: true },
    quartier: { type: String, default: '', trim: true },
    avenue: { type: String, default: '', trim: true },
    repere: { type: String, default: '', trim: true },
    aireSante: { type: String, default: '', trim: true },
  },

  // Antécédents (durables d'une grossesse à l'autre)
  antecedents: {
    gestite: { type: Number, min: 0, max: 30, default: null },
    parite: { type: Number, min: 0, max: 30, default: null },
    enfantsVivants: { type: Number, min: 0, max: 30, default: null },
    avortements: { type: Number, min: 0, max: 30, default: null },
    cesariennes: { type: Number, min: 0, max: 30, default: null },
    complicationsObstetricales: { type: String, default: '', trim: true },
    medicaux: { type: String, default: '', trim: true },
    chirurgicaux: { type: String, default: '', trim: true },
    allergies: { type: String, default: '', trim: true },
    medicaments: { type: String, default: '', trim: true },
    /** Cases de la fiche CPN : antécédents médicaux, gynéco-chirurgicaux et obstétricaux. */
    atcdMedicaux: cases(cpn.ATCD_MEDICAUX),
    atcdGynecoChirurgicaux: cases(cpn.ATCD_GYNECO_CHIRURGICAUX),
    atcdObstetricaux: cases(cpn.ATCD_OBSTETRICAUX),
    plusGrosPoidsNaissanceG: { type: Number, min: 300, max: 7000, default: null },
    dernierAccouchement: dateJour(),
  },

  etablissementId: { type: String, default: null },
  statut: { type: String, enum: STATUTS_PATIENTE, default: 'Suivi prénatal' },
  /** Espace en ligne de la patiente (activation par lien sécurisé : phase application mobile). */
  espaceEnLigne: { type: String, enum: ['Non activé', 'Invitation envoyée', 'Activé'], default: 'Non activé' },

  creePar: { type: auteurSchema, required: true },
  modifiePar: { type: auteurSchema, default: undefined },
}, {
  timestamps: true,
  toJSON: {
    transform: (doc, ret) => {
      versJson(doc, ret);
      delete ret.motDePasse;
      delete ret.photoCle;
      delete ret.telephoneChiffres;
      delete ret.telephone2Chiffres;
      return ret;
    },
  },
});

patienteSchema.pre('validate', function () {
  this.telephoneChiffres = (this.telephone || '').replace(/\D/g, '');
  this.telephone2Chiffres = (this.telephone2 || '').replace(/\D/g, '');
});

// Recherche et contrôle des doublons.
patienteSchema.index({ nom: 1, prenom: 1 });
patienteSchema.index({ dateNaissance: 1 });
// Analyses du tableau de bord par province.
patienteSchema.index({ 'adresse.province': 1, statut: 1 });

/** AC-PAT-000001, AC-PAT-000002… (l'index unique protège des collisions). */
patienteSchema.statics.prochainNumero = async function () {
  const dernier = await this.findOne({ numero: /^AC-PAT-\d+$/ }).sort({ numero: -1 }).select('numero');
  const n = dernier ? parseInt(dernier.numero.slice(7), 10) || 0 : 0;
  return `AC-PAT-${String(n + 1).padStart(6, '0')}`;
};

/** Âge en années révolues (date de naissance, sinon âge déclaré vieilli depuis sa saisie). */
patienteSchema.methods.age = function (aujourdhui = new Date()) {
  if (this.dateNaissance) {
    const n = new Date(this.dateNaissance);
    const anniversairePasse = aujourdhui.getUTCMonth() > n.getUTCMonth()
      || (aujourdhui.getUTCMonth() === n.getUTCMonth() && aujourdhui.getUTCDate() >= n.getUTCDate());
    return aujourdhui.getUTCFullYear() - n.getUTCFullYear() - (anniversairePasse ? 0 : 1);
  }
  if (this.ageDeclare != null) {
    const depuis = this.ageDeclareLe ? new Date(this.ageDeclareLe) : this.createdAt ?? aujourdhui;
    return this.ageDeclare + Math.floor((aujourdhui - depuis) / (365.25 * 86400000));
  }
  return null;
};

/** Téléphone masqué pour les listes de recherche (minimisation). */
patienteSchema.methods.telephoneMasque = function () {
  const chiffres = (this.telephone || '').replace(/\D/g, '');
  return chiffres.length >= 4 ? `•••• ${chiffres.slice(-4)}` : '';
};

module.exports = mongoose.model('Patiente', patienteSchema);
module.exports.STATUTS_PATIENTE = STATUTS_PATIENTE;
module.exports.CANAUX = CANAUX;
