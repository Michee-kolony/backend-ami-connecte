const mongoose = require('mongoose');

/**
 * Membre du comité de pilotage : propriétaire du projet AMI Santé Connect.
 * Il enregistre les établissements sanitaires et leur médecin chef, et consulte les indicateurs
 * consolidés de tous les établissements (agrégats, sans données nominatives des patientes).
 * Compte distinct du personnel soignant : il n'a accès à aucun dossier médical.
 */
const membreComiteSchema = new mongoose.Schema({
  prenom: { type: String, required: true, trim: true },
  nom: { type: String, required: true, trim: true, uppercase: true },
  sexe: { type: String, enum: ['F', 'M', ''], default: '' },
  fonction: { type: String, default: '', trim: true },
  /** Institution représentée au comité (ministère, partenaire, hôpital…). */
  organisation: { type: String, default: '', trim: true },
  telephone: { type: String, default: '', trim: true },
  photo: { type: String, default: null },
  photoCle: { type: String, default: null },
  /** Membre du comité qui a créé ce compte (absent pour le premier compte, créé par script). */
  creePar: { type: mongoose.Schema.Types.ObjectId, ref: 'MembreComite', default: null },
  ajoutePar: { type: new mongoose.Schema({ nom: String }, { _id: false }), default: undefined },
  email: { type: String, required: true, unique: true, trim: true, lowercase: true },
  motDePasse: { type: String, required: true, select: false },
  statut: { type: String, enum: ['Actif', 'Suspendu'], default: 'Actif' },
  derniereConnexion: { type: Date, default: null },
  doitChangerMotDePasse: { type: Boolean, default: true },
}, {
  timestamps: true,
  toJSON: {
    transform: (doc, ret) => {
      ret.id = String(ret._id);
      delete ret._id;
      delete ret.__v;
      delete ret.motDePasse;
      delete ret.photoCle;
      ret.creePar = ret.creePar ? String(ret.creePar) : null;
      ret.creeLe = ret.createdAt ?? null;
      return ret;
    },
  },
});

/** Instantané de l'auteur, enregistré sur les comptes et établissements qu'il crée. */
membreComiteSchema.methods.instantane = function () {
  return { nom: `${this.prenom} ${this.nom}`, role: 'Comité de pilotage', matricule: '' };
};

module.exports = mongoose.model('MembreComite', membreComiteSchema);
