const mongoose = require('mongoose');
const { zonesDeProvince } = require('../config/zonesSante');
const { ficheSchema } = require('./ficheEtablissement');
const { abrege, modulesActifs, completude, profilDe } = require('../config/ficheEtablissement');

const TYPES = [
  'Hôpital général de référence', 'Hôpital militaire', 'Centre de santé de référence',
  'Centre de santé', 'Poste de santé', 'Polyclinique', 'Clinique',
  // Fiche AMI (étape 1 du cahier des charges).
  'Hôpital provincial', 'Hôpital national', 'Centre médical', 'Autre',
  // Fiche « Identification générale de la structure ».
  'Laboratoire', 'Maternité',
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
  /** Code AMI (étape 1), ex. AMI-TAN-KAL-00124 : attribué automatiquement, jamais modifié. */
  codeAmi: { type: String, unique: true, sparse: true },
  nom: { type: String, required: true, trim: true },
  type: { type: String, enum: TYPES, required: true },
  secteur: { type: String, enum: SECTEURS, required: true },
  province: { type: String, required: true, trim: true },
  /** District sanitaire (en-tête de la fiche CPN), renseigné par le médecin chef. */
  districtSanitaire: { type: String, default: '', trim: true },
  /** Zones de santé couvertes (référentiel config/zonesSante.js, au moins une, de la province). */
  zonesSante: { type: [{ type: String, trim: true }], default: undefined },
  /** Zone de santé principale : la première de `zonesSante` (en-têtes, carte, épidémiologie). */
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
  /** Fiche AMI (étapes 1 à 10). Absente pour les établissements enregistrés avant elle. */
  fiche: { type: ficheSchema, default: undefined },
  statut: { type: String, enum: ['Actif', 'Suspendu'], default: 'Actif' },
  creePar: { type: mongoose.Schema.Types.ObjectId, ref: 'Soignant' },
  /** Membre du comité de pilotage qui a enregistré l'établissement. */
  creeParComite: { type: mongoose.Schema.Types.ObjectId, ref: 'MembreComite' },
}, {
  timestamps: true,
  toJSON: {
    transform: (doc, ret) => {
      ret.id = String(ret._id);
      // Établissements enregistrés avant la sélection multiple : leur zone unique.
      if (!ret.zonesSante?.length) ret.zonesSante = ret.zoneSante ? [ret.zoneSante] : [];
      ret.photos = (ret.photos || []).map((p) => p.url);
      ret.creeLe = ret.createdAt ? new Date(ret.createdAt).toISOString().slice(0, 10) : null;
      // La fiche AMI (dont le registre nominatif du personnel) n'est servie que par les routes
      // de la fiche, au comité et au médecin chef ; les listes n'en gardent que le résumé.
      ret.ficheAmi = doc.fiche ? {
        statut: doc.fiche.circuit?.statut ?? 'Brouillon',
        completude: completude(doc),
        modulesActifs: modulesActifs(doc),
        profil: profilDe(doc),
        niveauSanitaire: doc.fiche.identification?.niveauSanitaire ?? null,
        statutActuel: doc.fiche.identification?.statutActuel ?? null,
      } : null;
      delete ret.fiche;
      delete ret._id;
      delete ret.__v;
      return ret;
    },
  },
});

/** La zone principale suit la première zone sélectionnée. */
etablissementSchema.pre('validate', async function () {
  if (this.zonesSante?.length) this.zoneSante = this.zonesSante[0];
  // Code AMI attribué à la création (et, pour les établissements plus anciens, à leur
  // prochain enregistrement) ; jamais recalculé ensuite, même si la zone change.
  if (!this.codeAmi && this.province && this.zoneSante) {
    this.codeAmi = await this.constructor.prochainCodeAmi(this.province, this.zoneSante);
  }
});

/**
 * Message d'erreur si les zones de santé ne sont pas valides pour la province, sinon null.
 * Vérifiées seulement quand elles (ou la province) changent : les zones saisies librement
 * avant le référentiel ne bloquent pas les autres modifications.
 */
etablissementSchema.methods.erreurZones = function () {
  if (!this.isNew && !this.isModified('zonesSante') && !this.isModified('province')) return null;
  const zones = this.zonesSante ?? [];
  if (!zones.length) return 'Sélectionnez au moins une zone de santé.';
  if (new Set(zones).size !== zones.length) return 'La même zone de santé est choisie deux fois.';
  const valides = zonesDeProvince(this.province);
  const inconnue = zones.find((z) => !valides.includes(z));
  return inconnue ? `« ${inconnue} » n’est pas une zone de santé de la province ${this.province}.` : null;
};

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

/** Code AMI-<province>-<zone>-<numéro>, ex. AMI-TAN-KAL-00124 (numéro propre au couple province/zone). */
etablissementSchema.statics.prochainCodeAmi = async function (province, zone) {
  const prefixe = `AMI-${abreviation(province)}-${abrege(zone)}-`;
  const dernier = await this.findOne({ codeAmi: new RegExp(`^${prefixe}`) }).sort({ codeAmi: -1 });
  const n = dernier ? parseInt(dernier.codeAmi.slice(prefixe.length), 10) || 0 : 0;
  return prefixe + String(n + 1).padStart(5, '0');
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
    id: this.id, code: this.code, codeAmi: this.codeAmi ?? null, modulesActifs: modulesActifs(this), nom: this.nom, type: this.type, province: this.province,
    districtSanitaire: this.districtSanitaire, zoneSante: this.zoneSante, zonesSante: this.zonesSante?.length ? this.zonesSante : [this.zoneSante], aireSante: this.aireSante, adresse: this.adresse, photo: this.photos[0]?.url ?? null,
  };
};

module.exports = mongoose.model('Etablissement', etablissementSchema);
module.exports.TYPES = TYPES;
