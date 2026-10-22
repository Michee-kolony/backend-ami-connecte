const mongoose = require('mongoose');

const TYPES = [
  'Hôpital général de référence', 'Hôpital militaire', 'Centre de santé de référence',
  'Centre de santé', 'Poste de santé', 'Polyclinique', 'Clinique',
];
const SECTEURS = ['Public', 'Privé', 'Confessionnel', 'Militaire', 'ONG'];
const SERVICES = ['CPN', 'Maternité', 'Vaccination', 'Urgences', 'Ambulance', 'Pédiatrie', 'Laboratoire', 'Imagerie', 'Chirurgie'];

const photoSchema = new mongoose.Schema({
  url: { type: String, required: true },
  cle: { type: String, required: true },
}, { _id: false });

const etablissementSchema = new mongoose.Schema({
  /** Code unique, ex. ETS-KIN-0003. */
  code: { type: String, required: true, unique: true },
  nom: { type: String, required: true, trim: true },
  type: { type: String, enum: TYPES, required: true },
  secteur: { type: String, enum: SECTEURS, required: true },
  province: { type: String, required: true, trim: true },
  /** District sanitaire (en-tête de la fiche CPN), renseigné par le médecin chef. */
  districtSanitaire: { type: String, default: '', trim: true },
  zoneSante: { type: String, required: true, trim: true },
  aireSante: { type: String, default: '', trim: true },
  adresse: { type: String, required: true, trim: true },
  latitude: { type: Number, min: -90, max: 90, default: null },
  longitude: { type: Number, min: -180, max: 180, default: null },
  telephone: { type: String, required: true, trim: true },
  email: { type: String, default: '', trim: true, lowercase: true },
  responsable: { type: String, required: true, trim: true },
  fonctionResponsable: { type: String, default: '', trim: true },
  lits: { type: Number, min: 0, default: 0 },
  services: {
    type: [{ type: String, enum: SERVICES }],
    validate: { validator: (v) => v.length > 0, message: 'Sélectionnez au moins un service.' },
  },
  photos: { type: [photoSchema], default: [] },
  statut: { type: String, enum: ['Actif', 'Suspendu'], default: 'Actif' },
  creePar: { type: mongoose.Schema.Types.ObjectId, ref: 'Soignant' },
}, {
  timestamps: true,
  toJSON: {
    transform: (doc, ret) => {
      ret.id = String(ret._id);
      ret.photos = (ret.photos || []).map((p) => p.url);
      ret.creeLe = ret.createdAt ? new Date(ret.createdAt).toISOString().slice(0, 10) : null;
      delete ret._id;
      delete ret.__v;
      return ret;
    },
  },
});

/** Abréviation de la province : KIN pour Kinshasa, KCE pour Kongo-Central… */
function abreviation(province) {
  const mots = province.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().split(/[\s-]+/);
  return mots.length > 1 ? (mots[0][0] + mots[1].slice(0, 2)) : mots[0].slice(0, 3);
}

/** Code ETS-<province>-<numéro>, ex. ETS-KIN-0003. */
etablissementSchema.statics.prochainCode = async function (province) {
  const prefixe = `ETS-${abreviation(province)}-`;
  const dernier = await this.findOne({ code: new RegExp(`^${prefixe}`) }).sort({ code: -1 });
  const n = dernier ? parseInt(dernier.code.slice(prefixe.length), 10) || 0 : 0;
  return prefixe + String(n + 1).padStart(4, '0');
};

/** Établissements actifs parmi ces identifiants, dans l'ordre donné (le premier est le principal). */
etablissementSchema.statics.actifsParIds = async function (ids) {
  const valides = ids.filter((id) => mongoose.isValidObjectId(id));
  const trouves = await this.find({ _id: { $in: valides }, statut: 'Actif' });
  return valides.map((id) => trouves.find((e) => e.id === id)).filter(Boolean);
};

/** Message d'erreur si une affectation désigne un établissement inexistant ou suspendu, sinon null. */
etablissementSchema.statics.verifierAffectations = async function (affectations) {
  if (!Array.isArray(affectations) || !affectations.length) return 'Au moins un établissement est requis.';
  const ids = affectations.map((a) => String(a.etablissementId));
  if (new Set(ids).size !== ids.length) return 'Le même établissement est choisi deux fois.';
  const actifs = await this.actifsParIds(ids);
  return actifs.length === ids.length ? null : 'Un des établissements choisis n’existe pas ou est suspendu.';
};

/** Informations utiles à l'écran de connexion et à la barre latérale. */
etablissementSchema.methods.resume = function () {
  return {
    id: this.id, code: this.code, nom: this.nom, type: this.type, province: this.province,
    districtSanitaire: this.districtSanitaire, zoneSante: this.zoneSante, aireSante: this.aireSante, adresse: this.adresse, photo: this.photos[0]?.url ?? null,
  };
};

module.exports = mongoose.model('Etablissement', etablissementSchema);
