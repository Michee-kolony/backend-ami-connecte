const mongoose = require('mongoose');
const { auteurSchema, dateJour } = require('./commun');
const { STATUTS_CHAUFFEUR } = require('../config/urgences');

/**
 * Chauffeur d'ambulance : compte de l'application ami-connecte-chauffeur.
 * Identifiant de connexion : le matricule (CHF-0001) ; mot de passe haché (bcrypt).
 */
const chauffeurSchema = new mongoose.Schema({
  matricule: { type: String, required: true, unique: true },
  prenom: { type: String, required: true, trim: true },
  nom: { type: String, required: true, trim: true, uppercase: true },
  postnom: { type: String, default: '', trim: true, uppercase: true },
  telephone: { type: String, required: true, trim: true },
  /** Photo de profil (URL publique, comme celles du personnel) et sa clé R2. */
  photo: { type: String, default: null },
  photoCle: { type: String, default: null },
  /** Permis de conduire (facultatif : vide → absent, l'unicité ne porte que sur les numéros saisis). */
  permis: {
    type: String, unique: true, sparse: true, trim: true, uppercase: true,
    set: (v) => (v && String(v).trim() ? v : undefined),
  },
  permisExpire: dateJour(),
  statut: { type: String, enum: STATUTS_CHAUFFEUR, default: 'Actif' },
  motDePasse: { type: String, required: true, select: false },
  doitChangerMotDePasse: { type: Boolean, default: true },
  derniereConnexion: { type: Date, default: null },
  creePar: { type: auteurSchema, required: true },
}, {
  timestamps: true,
  toJSON: {
    transform: (doc, ret) => {
      ret.id = String(ret._id);
      delete ret._id;
      delete ret.__v;
      delete ret.motDePasse;
      delete ret.photoCle;
      return ret;
    },
  },
});

/** CHF-0001, CHF-0002… */
chauffeurSchema.statics.prochainMatricule = async function () {
  const dernier = await this.findOne({ matricule: /^CHF-\d+$/ }).sort({ matricule: -1 }).select('matricule');
  const n = dernier ? parseInt(dernier.matricule.slice(4), 10) || 0 : 0;
  return `CHF-${String(n + 1).padStart(4, '0')}`;
};

chauffeurSchema.methods.nomComplet = function () {
  return [this.prenom, this.nom, this.postnom].filter(Boolean).join(' ');
};

module.exports = mongoose.model('Chauffeur', chauffeurSchema);
