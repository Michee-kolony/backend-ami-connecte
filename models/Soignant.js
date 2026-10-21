const mongoose = require('mongoose');

const ROLES_MEDECIN = ['Médecin', 'Médecin chef de service', 'Médecin directeur'];
const ROLES_INFIRMIER = ['Infirmier(ère)', 'Infirmier(ère) titulaire', 'Infirmier(ère) superviseur(e)'];
const ROLES = [...ROLES_MEDECIN, ...ROLES_INFIRMIER];
const PIECES = ['Carte d’électeur', 'Passeport', 'Carte militaire', 'Permis de conduire'];

/** Rôles autorisés à gérer les comptes du personnel soignant. */
const ROLES_GESTION = ['Médecin chef de service'];

const affectationSchema = new mongoose.Schema({
  etablissementId: { type: String, required: true },
  service: { type: String, default: '' },
}, { _id: false });

const soignantSchema = new mongoose.Schema({
  matricule: { type: String, required: true, unique: true },
  // Identité
  prenom: { type: String, required: true, trim: true },
  nom: { type: String, required: true, trim: true, uppercase: true },
  postnom: { type: String, default: '', trim: true, uppercase: true },
  sexe: { type: String, enum: ['F', 'M'], required: true },
  dateNaissance: { type: String, required: true },
  lieuNaissance: { type: String, required: true, trim: true },
  nationalite: { type: String, required: true, trim: true },
  pieceType: { type: String, enum: PIECES, required: true },
  pieceNumero: { type: String, default: '', trim: true, uppercase: true },
  adresse: { type: String, required: true, trim: true },
  telephone: { type: String, required: true, trim: true },
  photo: { type: String },
  photoCle: { type: String },
  // Profession
  // Facultatif : vide → absent, pour que l'unicité ne s'applique qu'aux numéros renseignés.
  numeroOrdre: {
    type: String, unique: true, sparse: true, trim: true, uppercase: true,
    set: (v) => (v && String(v).trim() ? v : undefined),
  },
  grade: { type: String, required: true },
  specialite: { type: String, required: true },
  affectations: {
    type: [affectationSchema],
    validate: { validator: (v) => v.length > 0, message: 'Au moins un établissement est requis.' },
  },
  // Accès
  email: { type: String, required: true, unique: true, trim: true, lowercase: true },
  motDePasse: { type: String, required: true, select: false },
  role: { type: String, enum: ROLES, required: true },
  statut: { type: String, enum: ['Actif', 'Suspendu'], default: 'Actif' },
  derniereConnexion: { type: Date, default: null },
  doitChangerMotDePasse: { type: Boolean, default: true },
  creePar: { type: mongoose.Schema.Types.ObjectId, ref: 'Soignant' },
  // Traçabilité : identité de l'auteur figée à l'ajout, conservée même si son compte est supprimé.
  auteurAjout: {
    type: new mongoose.Schema({ nom: String, role: String, matricule: String }, { _id: false }),
    default: undefined,
  },
}, {
  timestamps: true,
  toJSON: {
    transform: (doc, ret) => {
      ret.id = String(ret._id);
      delete ret._id;
      delete ret.__v;
      delete ret.motDePasse;
      delete ret.photoCle;
      // ajoutePar : instantané enregistré, sinon l'auteur peuplé (comptes ajoutés avant l'instantané).
      const auteur = ret.creePar && typeof ret.creePar === 'object' && ret.creePar.prenom ? ret.creePar : null;
      const idAuteur = !ret.creePar ? null
        : ret.creePar instanceof mongoose.Types.ObjectId ? String(ret.creePar)
        : String(ret.creePar.id ?? ret.creePar._id);
      ret.ajoutePar = ret.auteurAjout?.nom
        ? { id: idAuteur, ...ret.auteurAjout }
        : auteur && { id: idAuteur, nom: `${auteur.prenom} ${auteur.nom}`, role: auteur.role, matricule: auteur.matricule };
      ret.creePar = idAuteur;
      delete ret.auteurAjout;
      return ret;
    },
  },
});

/** Instantané de l'auteur d'un ajout (voir auteurAjout). */
soignantSchema.statics.instantaneAuteur = (s) => ({ nom: `${s.prenom} ${s.nom}`, role: s.role, matricule: s.matricule });

/** Champs de l'auteur peuplés dans les listes. */
soignantSchema.statics.CHAMPS_AUTEUR = 'prenom nom role matricule';

/** MED-xxxx pour les médecins, INF-xxxx pour les infirmier·ères. */
soignantSchema.statics.prochainMatricule = async function (role) {
  const prefixe = ROLES_MEDECIN.includes(role) ? 'MED' : 'INF';
  const dernier = await this.findOne({ matricule: new RegExp(`^${prefixe}-`) }).sort({ matricule: -1 });
  const n = dernier ? parseInt(dernier.matricule.split('-')[1], 10) || 0 : 0;
  return `${prefixe}-${String(n + 1).padStart(4, '0')}`;
};

module.exports = mongoose.model('Soignant', soignantSchema);
/** Champs que chacun peut modifier sur son propre profil (ni rôle, ni statut, ni e-mail, ni matricule). */
module.exports.CHAMPS_PROFIL = [
  'prenom', 'nom', 'postnom', 'sexe', 'dateNaissance', 'lieuNaissance', 'nationalite',
  'pieceType', 'pieceNumero', 'adresse', 'telephone', 'numeroOrdre', 'grade', 'specialite',
];
module.exports.ROLES = ROLES;
module.exports.ROLES_MEDECIN = ROLES_MEDECIN;
module.exports.ROLES_INFIRMIER = ROLES_INFIRMIER;
module.exports.ROLES_GESTION = ROLES_GESTION;
