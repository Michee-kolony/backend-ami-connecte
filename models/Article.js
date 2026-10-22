const mongoose = require('mongoose');
const { auteurSchema, versJson } = require('./commun');

/** Public visé par le conseil. */
const CIBLES = ['Grossesse (CPN)', 'Après l’accouchement', 'Tous publics'];
/** Un article publié par un médecin attend l'approbation du médecin chef avant d'être visible de tous. */
const STATUTS = ['En attente', 'Approuvé'];
const PHOTOS_MAX = 4;

/** Photo ou vidéo stockée dans R2 (la clé sert à la supprimer avec l'article). */
const mediaSchema = new mongoose.Schema({
  type: { type: String, enum: ['image', 'video'], required: true },
  cle: { type: String, required: true },
  url: { type: String, required: true },
}, { _id: false });

/** Réponse du médecin auteur de l'article à un commentaire. */
const reponseSchema = new mongoose.Schema({
  auteur: { type: auteurSchema, required: true },
  texte: { type: String, required: true, trim: true, maxlength: 2000 },
  le: { type: Date, required: true },
}, { toJSON: { transform: versJson } });

const commentaireSchema = new mongoose.Schema({
  auteur: { type: auteurSchema, required: true },
  texte: { type: String, required: true, trim: true, maxlength: 2000 },
  le: { type: Date, required: true },
  reponses: { type: [reponseSchema], default: [] },
}, { toJSON: { transform: versJson } });

/**
 * Article de conseils publié par un médecin (jamais par un·e infirmier·ère) pour les femmes
 * suivies en CPN ou ayant accouché : 4 photos au maximum ou une seule vidéo.
 * Il reste « En attente » (visible de son auteur et du médecin chef seulement) jusqu'à ce que le
 * médecin chef l'approuve ; seul le médecin chef approuve ou supprime un article.
 */
const articleSchema = new mongoose.Schema({
  titre: { type: String, required: true, trim: true, maxlength: 200 },
  contenu: { type: String, required: true, trim: true, maxlength: 20000 },
  cible: { type: String, enum: CIBLES, default: 'Tous publics' },
  medias: {
    type: [mediaSchema],
    default: [],
    validate: {
      validator: (m) => (m.some((x) => x.type === 'video') ? m.length === 1 : m.length <= PHOTOS_MAX),
      message: `${PHOTOS_MAX} photos au maximum, ou une seule vidéo.`,
    },
  },
  auteur: { type: auteurSchema, required: true },
  /** Absent sur les articles publiés avant l'approbation : ils restent visibles (approuvés). */
  statut: { type: String, enum: STATUTS },
  approbation: {
    type: new mongoose.Schema({ par: { type: auteurSchema, required: true }, le: { type: Date, required: true } }, { _id: false }),
    default: undefined,
  },
  /** Identifiants des soignants qui aiment l'article (un « j'aime » par personne). */
  jaimes: { type: [String], default: [] },
  commentaires: { type: [commentaireSchema], default: [] },
}, { timestamps: true, toJSON: { transform: versJson } });

articleSchema.index({ createdAt: -1 });
articleSchema.index({ statut: 1, createdAt: -1 });

articleSchema.virtual('enAttente').get(function () {
  return this.statut === 'En attente';
});

module.exports = mongoose.model('Article', articleSchema);
module.exports.CIBLES = CIBLES;
module.exports.STATUTS = STATUTS;
module.exports.PHOTOS_MAX = PHOTOS_MAX;
