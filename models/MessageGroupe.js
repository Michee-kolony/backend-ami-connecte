const mongoose = require('mongoose');

/**
 * Message du groupe de pilotage : conversation commune à tous les médecins chefs et à tous les
 * membres du comité de pilotage. Le texte n'est jamais stocké en clair (config/chiffrement.js).
 */
const messageGroupeSchema = new mongoose.Schema({
  /** Groupe concerné (un seul aujourd'hui : « pilotage »). */
  groupe: { type: String, default: 'pilotage', index: true },
  auteurId: { type: mongoose.Schema.Types.ObjectId, required: true },
  /** Nature de l'auteur : médecin chef (soignant) ou membre du comité. */
  auteurType: { type: String, enum: ['soignant', 'comite'], required: true },
  contenu: {
    v: { type: Number, required: true },
    iv: { type: String, required: true },
    tag: { type: String, required: true },
    d: { type: String, required: true },
  },
  /** Accusés de lecture : qui a lu, et quand. */
  lusPar: [{ _id: false, id: mongoose.Schema.Types.ObjectId, le: Date }],
}, { timestamps: true });

messageGroupeSchema.index({ groupe: 1, createdAt: -1 });

module.exports = mongoose.model('MessageGroupe', messageGroupeSchema, 'messages_groupes');
