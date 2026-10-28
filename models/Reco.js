const mongoose = require('mongoose');
const { auteurSchema } = require('./commun');

/** Quartier, village ou secteur, comparé sans accents ni casse ni espaces superflus. */
const normaliserZone = (z) => String(z || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Relais communautaire (RECO) : compte de l'application RECO (espace /reco d'ami-sante).
 * Identifiant de connexion : le matricule (RECO-0001) ; mot de passe haché (bcrypt).
 * Le RECO ne voit que les tâches qui lui sont attribuées, dans son secteur.
 */
const recoSchema = new mongoose.Schema({
  matricule: { type: String, required: true, unique: true },
  prenom: { type: String, required: true, trim: true },
  nom: { type: String, required: true, trim: true, uppercase: true },
  postnom: { type: String, default: '', trim: true, uppercase: true },
  sexe: { type: String, enum: ['F', 'M'], required: true },
  telephone: { type: String, required: true, trim: true },
  /** Photo de profil (URL publique, comme celles du personnel et des chauffeurs) et sa clé R2. */
  photo: { type: String, default: null },
  photoCle: { type: String, default: null },
  /** Structure de rattachement (centre de santé) et aire de santé. */
  etablissementId: { type: String, required: true, index: true },
  aireSante: { type: String, default: '', trim: true },
  /** Secteur couvert : quartiers, villages ou avenues (attribution automatique des tâches). */
  zones: { type: [String], default: [] },
  zonesNormalisees: { type: [String], default: [], index: true, select: false },
  /** Superviseur communautaire (soignant) référent. */
  superviseurId: { type: mongoose.Schema.Types.ObjectId, ref: 'Soignant', default: null },
  statut: { type: String, enum: ['Actif', 'Suspendu'], default: 'Actif' },
  motDePasse: { type: String, required: true, select: false },
  doitChangerMotDePasse: { type: Boolean, default: true },
  /** Téléphone perdu ou compromis : tout jeton émis avant cette date est refusé. */
  sessionsRevoqueesLe: { type: Date, default: null },
  derniereConnexion: { type: Date, default: null },
  derniereSynchronisation: { type: Date, default: null },
  creePar: { type: auteurSchema, required: true },
  modifiePar: { type: auteurSchema, default: undefined },
}, {
  timestamps: true,
  toJSON: {
    transform: (doc, ret) => {
      ret.id = String(ret._id);
      ret.superviseurId = ret.superviseurId ? String(ret.superviseurId) : null;
      delete ret._id;
      delete ret.__v;
      delete ret.motDePasse;
      delete ret.photoCle;
      delete ret.zonesNormalisees;
      return ret;
    },
  },
});

recoSchema.pre('validate', function () {
  this.zones = [...new Set((this.zones || []).map((z) => String(z).trim()).filter(Boolean))];
  this.zonesNormalisees = this.zones.map(normaliserZone);
});

/** RECO-0001, RECO-0002… */
recoSchema.statics.prochainMatricule = async function () {
  const dernier = await this.findOne({ matricule: /^RECO-\d+$/ }).sort({ matricule: -1 }).select('matricule');
  const n = dernier ? parseInt(dernier.matricule.slice(5), 10) || 0 : 0;
  return `RECO-${String(n + 1).padStart(4, '0')}`;
};

/** Auteur figé d'une action du RECO (historique des tâches). */
recoSchema.methods.auteur = function () {
  return { id: this.id, nom: `${this.prenom} ${this.nom}`, role: 'RECO', matricule: this.matricule };
};

module.exports = mongoose.model('Reco', recoSchema, 'recos');
module.exports.normaliserZone = normaliserZone;
