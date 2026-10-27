const mongoose = require('mongoose');

/**
 * Message du chat d'une urgence : conversation commune à la patiente, au chauffeur envoyé et à
 * la régulation (personnel). Texte chiffré au repos (config/chiffrement.js), jamais modifié.
 */
const messageUrgenceSchema = new mongoose.Schema({
  urgenceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Urgence', required: true, index: true },
  auteur: {
    type: new mongoose.Schema({
      type: { type: String, enum: ['patiente', 'chauffeur', 'regulation'], required: true },
      id: { type: String, required: true },
      /** Nom affiché, figé à l'envoi (« Marie TSHIBANDA », « Bienvenu LEMA »…). */
      nom: { type: String, required: true },
    }, { _id: false }),
    required: true,
  },
  contenu: {
    v: { type: Number, required: true },
    iv: { type: String, required: true },
    tag: { type: String, required: true },
    d: { type: String, required: true },
  },
}, { timestamps: { createdAt: true, updatedAt: false } });

messageUrgenceSchema.index({ urgenceId: 1, createdAt: 1 });

module.exports = mongoose.model('MessageUrgence', messageUrgenceSchema);
