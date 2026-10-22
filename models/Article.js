const mongoose = require('mongoose');
const { auteurSchema, versJson } = require('./commun');

/** Public visé par le conseil. */
const CIBLES = ['Grossesse (CPN)', 'Après l’accouchement', 'Tous publics'];
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
 * Chacun ne supprime que ce qu'il a publié ; le médecin chef peut tout supprimer.
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
  /** Identifiants des soignants qui aiment l'article (un « j'aime » par personne). */
  jaimes: { type: [String], default: [] },
  commentaires: { type: [commentaireSchema], default: [] },
}, { timestamps: true, toJSON: { transform: versJson } });

articleSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Article', articleSchema);
module.exports.CIBLES = CIBLES;
module.exports.PHOTOS_MAX = PHOTOS_MAX;
